use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use octocode_core::{
    ConfigPaths, ConversationMessage, ConversationRole, ConversationSession, ConversationStore,
    OctoError, SessionStore, SessionSummary,
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

pub struct FileSessionStore {
    sessions_dir: PathBuf,
    transcripts_dir: PathBuf,
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
        })
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
        let mut parts = raw.lines();
        let id = parts.next().unwrap_or_default().trim().to_string();
        let title = parts.next().unwrap_or_default().trim().to_string();
        let model = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if id.is_empty() {
            return Err(OctoError::Session(String::from("session id is empty")));
        }
        Ok(SessionSummary { id, title, model })
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
            "{}\n{}\n{}\n",
            session.id,
            session.title,
            session.model.unwrap_or_default()
        );
        fs::write(file_path, body)
            .map_err(|error| OctoError::Session(format!("failed to write session file: {error}")))
    }
}

impl ConversationStore for FileSessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        let summary = self.load_summary(id)?;
        Ok(ConversationSession {
            summary,
            messages: self.load_messages(id),
        })
    }

    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError> {
        let mut messages = self.load_messages(session_id);
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