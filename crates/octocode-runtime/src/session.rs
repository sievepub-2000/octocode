use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use octocode_core::{
    ConfigPaths, ConversationMessage, ConversationRole, ConversationSession, ConversationStore,
    OctoError, SessionStore, SessionSummary, TurnLifecycle, TurnLifecyclePhase, TurnStateStore,
};

#[derive(Default)]
pub struct MemorySessionStore {
    sessions: Vec<SessionSummary>,
}

impl MemorySessionStore {
    pub fn new() -> Self {
        Self {
            sessions: vec![SessionSummary {
                id: String::from("bootstrap"),
                title: String::from("Bootstrap Session"),
                model: None,
                parent_id: None,
                branch_name: None,
                total_input_tokens: 0,
                total_output_tokens: 0,
            }],
        }
    }
}

impl SessionStore for MemorySessionStore {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        Ok(self.sessions.clone())
    }

    fn save_session(&self, _session: SessionSummary) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist sessions",
        )))
    }
}

impl ConversationStore for MemorySessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        let summary = self
            .sessions
            .iter()
            .find(|session| session.id == id)
            .cloned()
            .ok_or_else(|| OctoError::Session(format!("unknown session: {id}")))?;
        Ok(ConversationSession {
            summary,
            messages: Vec::new(),
            turn: TurnLifecycle::default(),
        })
    }

    fn append_message(&self, _session_id: &str, _message: ConversationMessage) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist messages",
        )))
    }

    fn replace_messages(
        &self,
        _session_id: &str,
        _messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist messages",
        )))
    }

    fn latest_session_id(&self) -> Result<Option<String>, OctoError> {
        Ok(self.sessions.last().map(|session| session.id.clone()))
    }
}

impl TurnStateStore for MemorySessionStore {
    fn load_turn_state(&self, _session_id: &str) -> Result<TurnLifecycle, OctoError> {
        Ok(TurnLifecycle::default())
    }

    fn save_turn_state(&self, _session_id: &str, _turn: &TurnLifecycle) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist turn state",
        )))
    }
}

pub struct FileSessionStore {
    sessions_dir: PathBuf,
    transcripts_dir: PathBuf,
    /// Optional workspace root used to opportunistically index every
    /// appended message into the FTS5 search corpus. When unset (the
    /// default) the store stays purely file-backed and tests that do
    /// not exercise search remain unaffected.
    search_index_root: Option<PathBuf>,
}

impl FileSessionStore {
    pub fn new(paths: &ConfigPaths) -> Result<Self, OctoError> {
        let sessions_dir = PathBuf::from(&paths.data_home).join("sessions");
        let transcripts_dir = PathBuf::from(&paths.data_home).join("transcripts");
        fs::create_dir_all(&sessions_dir)
            .map_err(|error| OctoError::Session(format!("failed to create sessions dir: {error}")))?;
        fs::create_dir_all(&transcripts_dir).map_err(|error| {
            OctoError::Session(format!("failed to create transcripts dir: {error}"))
        })?;
        Ok(Self {
            sessions_dir,
            transcripts_dir,
            search_index_root: None,
        })
    }

    /// Enable auto-indexing of every appended message into the FTS5
    /// search corpus rooted at `workspace_root`. Indexing failures are
    /// swallowed so they cannot block conversation persistence — the
    /// search index is best-effort, the transcript is the source of
    /// truth.
    #[allow(dead_code)]
    pub fn with_search_index_root(mut self, workspace_root: impl Into<PathBuf>) -> Self {
        self.search_index_root = Some(workspace_root.into());
        self
    }

    fn session_file_path(&self, id: &str) -> PathBuf {
        self.sessions_dir.join(format!("{id}.session"))
    }

    fn transcript_file_path(&self, id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{id}.messages"))
    }

    fn load_summary(&self, id: &str) -> Result<SessionSummary, OctoError> {
        let path = self.session_file_path(id);
        let raw = fs::read_to_string(&path).map_err(|error| {
            OctoError::Session(format!("failed to read session file {}: {error}", path.display()))
        })?;

        // Support both legacy 3-line format and new key=value format
        let mut kv_id = String::new();
        let mut kv_title = String::new();
        let mut kv_model: Option<String> = None;
        let mut kv_parent_id: Option<String> = None;
        let mut kv_branch_name: Option<String> = None;
        let mut kv_total_input_tokens: u32 = 0;
        let mut kv_total_output_tokens: u32 = 0;

        let lines: Vec<&str> = raw.lines().collect();
        let is_kv = lines.first().map(|l| l.contains('=')).unwrap_or(false);

        if is_kv {
            for line in &lines {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
                if let Some((key, val)) = trimmed.split_once('=') {
                    let val = val.trim();
                    match key.trim() {
                        "id" => kv_id = val.to_string(),
                        "title" => kv_title = val.to_string(),
                        "model" => { if !val.is_empty() { kv_model = Some(val.to_string()); } }
                        "parent_id" => { if !val.is_empty() { kv_parent_id = Some(val.to_string()); } }
                        "branch_name" => { if !val.is_empty() { kv_branch_name = Some(val.to_string()); } }
                        "total_input_tokens" => kv_total_input_tokens = val.parse().unwrap_or(0),
                        "total_output_tokens" => kv_total_output_tokens = val.parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }
        } else {
            // Legacy 3-line format: id\ntitle\nmodel
            let mut parts = lines.iter();
            kv_id = parts.next().unwrap_or(&"").trim().to_string();
            kv_title = parts.next().unwrap_or(&"").trim().to_string();
            kv_model = parts.next()
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(str::to_string);
        }

        if kv_id.is_empty() {
            return Err(OctoError::Session(String::from("session id is empty")));
        }
        Ok(SessionSummary {
            id: kv_id,
            title: kv_title,
            model: kv_model,
            parent_id: kv_parent_id,
            branch_name: kv_branch_name,
            total_input_tokens: kv_total_input_tokens,
            total_output_tokens: kv_total_output_tokens,
        })
    }

    fn load_messages(&self, id: &str) -> Vec<ConversationMessage> {
        let transcript_path = self.transcript_file_path(id);
        let raw = fs::read_to_string(&transcript_path).unwrap_or_default();
        raw.lines()
            .filter_map(|line| {
                let (role, content) = line.split_once('\t')?;
                Some(ConversationMessage {
                    role: ConversationRole::parse(role),
                    content: content.replace("\\n", "\n"),
                })
            })
            .collect()
    }

    fn load_turn(&self, id: &str) -> Result<TurnLifecycle, OctoError> {
        let path = self.session_file_path(id);
        let raw = fs::read_to_string(&path).map_err(|error| {
            OctoError::Session(format!("failed to read session file {}: {error}", path.display()))
        })?;

        let mut turn = TurnLifecycle::default();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((key, value)) = trimmed.split_once('=') else {
                continue;
            };
            let value = value.trim();
            match key.trim() {
                "turn_id" => {
                    if !value.is_empty() {
                        turn.turn_id = Some(String::from(value));
                    }
                }
                "turn_phase" => turn.phase = TurnLifecyclePhase::parse(value),
                "turn_started_at_ms" => turn.started_at_ms = value.parse::<u128>().ok(),
                "turn_updated_at_ms" => turn.updated_at_ms = value.parse::<u128>().ok(),
                "turn_finished_at_ms" => turn.finished_at_ms = value.parse::<u128>().ok(),
                "turn_last_error" => {
                    if !value.is_empty() {
                        turn.last_error = Some(String::from(value));
                    }
                }
                "turn_active_sse_clients" => {
                    turn.active_sse_clients = value.parse::<usize>().unwrap_or(0)
                }
                _ => {}
            }
        }

        Ok(turn)
    }

    fn write_turn(&self, session_id: &str, turn: &TurnLifecycle) -> Result<(), OctoError> {
        let summary = self.load_summary(session_id)?;
        let file_path = self.session_file_path(session_id);
        let body = format!(
            concat!(
                "id={id}\n",
                "title={title}\n",
                "model={model}\n",
                "parent_id={parent_id}\n",
                "branch_name={branch_name}\n",
                "total_input_tokens={ti}\n",
                "total_output_tokens={to}\n",
                "turn_id={turn_id}\n",
                "turn_phase={turn_phase}\n",
                "turn_started_at_ms={turn_started_at_ms}\n",
                "turn_updated_at_ms={turn_updated_at_ms}\n",
                "turn_finished_at_ms={turn_finished_at_ms}\n",
                "turn_last_error={turn_last_error}\n",
                "turn_active_sse_clients={turn_active_sse_clients}\n",
            ),
            id = summary.id,
            title = summary.title,
            model = summary.model.as_deref().unwrap_or(""),
            parent_id = summary.parent_id.as_deref().unwrap_or(""),
            branch_name = summary.branch_name.as_deref().unwrap_or(""),
            ti = summary.total_input_tokens,
            to = summary.total_output_tokens,
            turn_id = turn.turn_id.as_deref().unwrap_or(""),
            turn_phase = turn.phase.as_str(),
            turn_started_at_ms = turn.started_at_ms.map(|value| value.to_string()).unwrap_or_default(),
            turn_updated_at_ms = turn.updated_at_ms.map(|value| value.to_string()).unwrap_or_default(),
            turn_finished_at_ms = turn.finished_at_ms.map(|value| value.to_string()).unwrap_or_default(),
            turn_last_error = turn.last_error.as_deref().unwrap_or(""),
            turn_active_sse_clients = turn.active_sse_clients,
        );
        let tmp_path = file_path.with_extension("session.tmp");
        fs::write(&tmp_path, &body)
            .map_err(|error| OctoError::Session(format!("failed to write session tmp: {error}")))?;
        fs::rename(&tmp_path, &file_path)
            .map_err(|error| OctoError::Session(format!("failed to rename session file: {error}")))
    }

    pub fn load_turn_state(&self, id: &str) -> Result<TurnLifecycle, OctoError> {
        self.load_turn(id)
    }

    pub fn save_turn_state(&self, session_id: &str, turn: &TurnLifecycle) -> Result<(), OctoError> {
        self.write_turn(session_id, turn)
    }

    fn write_messages(&self, id: &str, messages: &[ConversationMessage]) -> Result<(), OctoError> {
        let transcript_path = self.transcript_file_path(id);
        if let Some(parent) = transcript_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Session(format!(
                    "failed to create transcript dir {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let body = messages
            .iter()
            .map(|message| {
                format!(
                    "{}\t{}",
                    message.role.as_str(),
                    message.content.replace('\n', "\\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let normalized = if body.is_empty() {
            String::new()
        } else {
            format!("{body}\n")
        };

        fs::write(&transcript_path, normalized).map_err(|error| {
            OctoError::Session(format!(
                "failed to write transcript {}: {error}",
                transcript_path.display()
            ))
        })
    }

    fn last_modified_for(&self, id: &str) -> Option<SystemTime> {
        let transcript_path = self.transcript_file_path(id);
        let session_path = self.session_file_path(id);
        transcript_path
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .or_else(|| session_path.metadata().and_then(|meta| meta.modified()).ok())
    }

    /// Remove sessions older than `max_age` and keep at most `max_count` sessions.
    pub fn cleanup(&self, max_age: std::time::Duration, max_count: usize) -> Result<usize, OctoError> {
        let now = SystemTime::now();
        let mut entries: Vec<(String, SystemTime)> = Vec::new();

        let dir = fs::read_dir(&self.sessions_dir).map_err(|e| {
            OctoError::Session(format!("cleanup: failed to read sessions dir: {e}"))
        })?;
        for entry in dir {
            let entry = entry.map_err(|e| OctoError::Session(format!("cleanup entry: {e}")))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("session") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|v| v.to_str()).map(String::from) else {
                continue;
            };
            let modified = self.last_modified_for(&id).unwrap_or(SystemTime::UNIX_EPOCH);
            entries.push((id, modified));
        }

        // Sort newest first
        entries.sort_by(|a, b| b.1.cmp(&a.1));

        let mut removed = 0usize;
        for (index, (id, modified)) in entries.iter().enumerate() {
            let expired = now.duration_since(*modified).unwrap_or_default() > max_age;
            let over_limit = index >= max_count;
            if expired || over_limit {
                let _ = fs::remove_file(self.session_file_path(id));
                let _ = fs::remove_file(self.transcript_file_path(id));
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn delete_session(&self, id: &str) -> Result<bool, OctoError> {
        let mut removed = false;
        let session_path = self.session_file_path(id);
        let transcript_path = self.transcript_file_path(id);

        if session_path.exists() {
            fs::remove_file(&session_path).map_err(|error| {
                OctoError::Session(format!(
                    "failed to delete session file {}: {error}",
                    session_path.display()
                ))
            })?;
            removed = true;
        }

        if transcript_path.exists() {
            fs::remove_file(&transcript_path).map_err(|error| {
                OctoError::Session(format!(
                    "failed to delete transcript file {}: {error}",
                    transcript_path.display()
                ))
            })?;
            removed = true;
        }

        Ok(removed)
    }

    pub fn delete_all_sessions(&self) -> Result<usize, OctoError> {
        let session_ids = self
            .list_sessions()?
            .into_iter()
            .map(|session| session.id)
            .collect::<Vec<_>>();
        let mut removed = 0usize;
        for session_id in session_ids {
            if self.delete_session(&session_id)? {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

impl SessionStore for FileSessionStore {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        let mut sessions = Vec::new();
        let entries = fs::read_dir(&self.sessions_dir)
            .map_err(|error| OctoError::Session(format!("failed to read sessions dir: {error}")))?;

        for entry in entries {
            let entry = entry
                .map_err(|error| OctoError::Session(format!("failed to read session entry: {error}")))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("session") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            sessions.push(self.load_summary(id)?);
        }

        sessions.sort_by(|left, right| right.id.cmp(&left.id));
        Ok(sessions)
    }

    fn save_session(&self, session: SessionSummary) -> Result<(), OctoError> {
        let file_path = self.session_file_path(&session.id);
        let body = format!(
            concat!(
                "id={id}\n",
                "title={title}\n",
                "model={model}\n",
                "parent_id={parent_id}\n",
                "branch_name={branch_name}\n",
                "total_input_tokens={ti}\n",
                "total_output_tokens={to}\n",
                "turn_id=\n",
                "turn_phase=idle\n",
                "turn_started_at_ms=\n",
                "turn_updated_at_ms=\n",
                "turn_finished_at_ms=\n",
                "turn_last_error=\n",
                "turn_active_sse_clients=0\n",
            ),
            id = session.id,
            title = session.title,
            model = session.model.as_deref().unwrap_or(""),
            parent_id = session.parent_id.as_deref().unwrap_or(""),
            branch_name = session.branch_name.as_deref().unwrap_or(""),
            ti = session.total_input_tokens,
            to = session.total_output_tokens,
        );
        // Atomic write: write to temp then rename.
        let tmp_path = file_path.with_extension("session.tmp");
        fs::write(&tmp_path, &body)
            .map_err(|error| OctoError::Session(format!("failed to write session tmp: {error}")))?;
        fs::rename(&tmp_path, &file_path)
            .map_err(|error| OctoError::Session(format!("failed to rename session file: {error}")))
    }
}

impl ConversationStore for FileSessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        let summary = self.load_summary(id)?;
        Ok(ConversationSession {
            summary,
            messages: self.load_messages(id),
            turn: self.load_turn(id)?,
        })
    }

    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError> {
        let mut messages = self.load_messages(session_id);
        // Best-effort FTS5 indexing of the new segment, gated on the
        // optional `search_index_root`. Errors are intentionally
        // ignored — the transcript persistence below remains the
        // source of truth and must never be blocked by a search-side
        // failure.
        if let Some(root) = &self.search_index_root {
            let segment = format!("{}: {}", message.role.as_str(), message.content);
            if let Ok(store) = crate::sqlite_store::SqliteStore::open(root) {
                let _ = store.index_session_segment(session_id, &segment);
            }
        }
        messages.push(message);
        self.write_messages(session_id, &messages)
    }

    fn replace_messages(
        &self,
        session_id: &str,
        messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError> {
        self.write_messages(session_id, &messages)
    }

    fn latest_session_id(&self) -> Result<Option<String>, OctoError> {
        let sessions = self.list_sessions()?;
        let latest = sessions
            .iter()
            .max_by_key(|session| self.last_modified_for(&session.id))
            .map(|session| session.id.clone());
        Ok(latest)
    }
}

impl TurnStateStore for FileSessionStore {
    fn load_turn_state(&self, session_id: &str) -> Result<TurnLifecycle, OctoError> {
        self.load_turn(session_id)
    }

    fn save_turn_state(&self, session_id: &str, turn: &TurnLifecycle) -> Result<(), OctoError> {
        self.write_turn(session_id, turn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn temp_store(label: &str) -> (FileSessionStore, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("octocode-session-test-{}-{}", label, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let paths = ConfigPaths {
            config_home: root.join("config").to_string_lossy().to_string(),
            cache_home: root.join("cache").to_string_lossy().to_string(),
            data_home: root.join("data").to_string_lossy().to_string(),
        };
        let store = FileSessionStore::new(&paths).expect("create store");
        (store, root)
    }

    #[test]
    fn cleanup_removes_excess_sessions() {
        let (store, root) = temp_store("cleanup");
        for i in 0..5 {
            let summary = SessionSummary {
                id: format!("sess-{i}"),
                title: format!("Title {i}"),
                model: None,
                parent_id: None,
                branch_name: None,
                total_input_tokens: 0,
                total_output_tokens: 0,
            };
            store.save_session(summary).expect("save");
        }
        let removed = store.cleanup(Duration::from_secs(3600), 3).expect("cleanup");
        assert_eq!(removed, 2, "should remove 2 excess sessions");
        let remaining = store.list_sessions().expect("list");
        assert_eq!(remaining.len(), 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_preserves_recent_sessions() {
        let (store, root) = temp_store("preserve");
        let summary = SessionSummary {
            id: String::from("recent"),
            title: String::from("Recent"),
            model: None,
            parent_id: None,
            branch_name: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
        };
        store.save_session(summary).expect("save");
        let removed = store.cleanup(Duration::from_secs(3600), 100).expect("cleanup");
        assert_eq!(removed, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_session_removes_summary_and_transcript() {
        let (store, root) = temp_store("delete-one");
        let summary = SessionSummary {
            id: String::from("delete-me"),
            title: String::from("Delete Me"),
            model: None,
            parent_id: None,
            branch_name: None,
            total_input_tokens: 0,
            total_output_tokens: 0,
        };
        store.save_session(summary).expect("save");
        store
            .append_message(
                "delete-me",
                ConversationMessage {
                    role: ConversationRole::User,
                    content: String::from("hello"),
                },
            )
            .expect("append");

        let removed = store.delete_session("delete-me").expect("delete");

        assert!(removed);
        assert!(store.list_sessions().expect("list").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_all_sessions_removes_everything() {
        let (store, root) = temp_store("delete-all");
        for index in 0..3 {
            store
                .save_session(SessionSummary {
                    id: format!("sess-{index}"),
                    title: format!("Session {index}"),
                    model: None,
                    parent_id: None,
                    branch_name: None,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                })
                .expect("save");
        }

        let removed = store.delete_all_sessions().expect("delete all");

        assert_eq!(removed, 3);
        assert!(store.list_sessions().expect("list").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn append_message_auto_indexes_into_fts5_when_root_set() {
        // Pin a unique workspace root so this test never collides with
        // the temp-store root above (which lives under data_home, not
        // workspace_root) or with other parallel tests.
        let workspace = std::env::temp_dir().join(format!(
            "octocode-session-fts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&workspace);
        fs::create_dir_all(&workspace).unwrap();

        let (store, data_root) = temp_store("fts-hook");
        let store = store.with_search_index_root(&workspace);

        store
            .save_session(SessionSummary {
                id: String::from("sess-fts"),
                title: String::from("fts session"),
                model: None,
                parent_id: None,
                branch_name: None,
                total_input_tokens: 0,
                total_output_tokens: 0,
            })
            .expect("save");
        store
            .append_message(
                "sess-fts",
                ConversationMessage {
                    role: ConversationRole::User,
                    content: String::from("dockerized smoke build pipeline"),
                },
            )
            .expect("append");

        // The auto-index path opens a SqliteStore at `workspace`, so
        // searching the same root must surface the appended segment.
        let store_db = crate::sqlite_store::SqliteStore::open(&workspace).unwrap();
        let hits = store_db.search_sessions("dockerized", 10).unwrap();
        assert!(
            hits.iter().any(|(sid, _)| sid == "sess-fts"),
            "expected auto-indexed segment for sess-fts; got {hits:?}"
        );

        let _ = fs::remove_dir_all(&data_root);
        let _ = fs::remove_dir_all(&workspace);
    }
}