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

    fn validate_session_id(id: &str) -> Result<(), OctoError> {
        if id.trim().is_empty() {
            return Err(OctoError::Session(String::from("session id is empty")));
        }
        let valid = id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
        if !valid || id.contains("..") {
            return Err(OctoError::Session(format!(
                "session id contains unsupported characters: {id}"
            )));
        }
        Ok(())
    }

    fn session_file_path(&self, id: &str) -> PathBuf {
        self.sessions_dir.join(format!("{id}.session"))
    }

    fn transcript_file_path(&self, id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{id}.messages"))
    }

    fn transcript_jsonl_path(&self, id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{id}.messages.jsonl"))
    }

    fn atomic_write(path: &PathBuf, body: &str) -> Result<(), OctoError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Session(format!(
                    "failed to create parent dir {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let tmp = path.with_extension(format!(
            "{}.tmp",
            path.extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("octocode")
        ));
        fs::write(&tmp, body).map_err(|error| {
            OctoError::Session(format!("failed to write temp file {}: {error}", tmp.display()))
        })?;
        fs::rename(&tmp, path).map_err(|error| {
            OctoError::Session(format!(
                "failed to replace {} with {}: {error}",
                path.display(),
                tmp.display()
            ))
        })
    }

    fn load_summary(&self, id: &str) -> Result<SessionSummary, OctoError> {
        Self::validate_session_id(id)?;
        let path = self.session_file_path(id);
        let raw = fs::read_to_string(&path).map_err(|error| {
            OctoError::Session(format!("failed to read session file {}: {error}", path.display()))
        })?;
        if raw.trim_start().starts_with('{') {
            return parse_summary_json_line(raw.trim());
        }
        parse_legacy_summary(&raw)
    }

    fn load_messages(&self, id: &str) -> Vec<ConversationMessage> {
        if Self::validate_session_id(id).is_err() {
            return Vec::new();
        }
        let jsonl_path = self.transcript_jsonl_path(id);
        if jsonl_path.is_file() {
            let raw = fs::read_to_string(&jsonl_path).unwrap_or_default();
            return raw
                .lines()
                .filter_map(parse_message_json_line)
                .collect();
        }

        let transcript_path = self.transcript_file_path(id);
        let raw = fs::read_to_string(&transcript_path).unwrap_or_default();
        raw.lines()
            .filter_map(|line| {
                let (role, content) = line.split_once('\t')?;
                Some(ConversationMessage {
                    role: ConversationRole::parse(role),
                    content: content.replace("\\n", "\n").replace("\\t", "\t"),
                })
            })
            .collect()
    }

    fn write_messages(&self, id: &str, messages: &[ConversationMessage]) -> Result<(), OctoError> {
        Self::validate_session_id(id)?;
        let transcript_path = self.transcript_jsonl_path(id);
        let body = messages
            .iter()
            .map(message_to_json_line)
            .collect::<Vec<_>>()
            .join("\n");
        let normalized = if body.is_empty() {
            String::new()
        } else {
            format!("{body}\n")
        };
        Self::atomic_write(&transcript_path, &normalized)
    }

    fn last_modified_for(&self, id: &str) -> Option<SystemTime> {
        let jsonl_path = self.transcript_jsonl_path(id);
        let transcript_path = self.transcript_file_path(id);
        let session_path = self.session_file_path(id);
        jsonl_path
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .or_else(|| transcript_path.metadata().and_then(|meta| meta.modified()).ok())
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
            if Self::validate_session_id(id).is_err() {
                continue;
            }
            sessions.push(self.load_summary(id)?);
        }

        sessions.sort_by(|left, right| right.id.cmp(&left.id));
        Ok(sessions)
    }

    fn save_session(&self, session: SessionSummary) -> Result<(), OctoError> {
        Self::validate_session_id(&session.id)?;
        let file_path = self.session_file_path(&session.id);
        let body = summary_to_json_line(&session);
        Self::atomic_write(&file_path, &format!("{body}\n"))
    }
}

impl ConversationStore for FileSessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        Self::validate_session_id(id)?;
        let summary = self.load_summary(id)?;
        Ok(ConversationSession {
            summary,
            messages: self.load_messages(id),
        })
    }

    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError> {
        Self::validate_session_id(session_id)?;
        let mut messages = self.load_messages(session_id);
        messages.push(message);
        self.write_messages(session_id, &messages)
    }

    fn replace_messages(
        &self,
        session_id: &str,
        messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError> {
        Self::validate_session_id(session_id)?;
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

fn parse_legacy_summary(raw: &str) -> Result<SessionSummary, OctoError> {
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
    Ok(SessionSummary {
        id,
        title,
        model,
        parent_id: None,
        branch_name: None,
        total_input_tokens: 0,
        total_output_tokens: 0,
    })
}

fn summary_to_json_line(summary: &SessionSummary) -> String {
    format!(
        concat!(
            "{{",
            "\"id\":\"{}\",",
            "\"title\":\"{}\",",
            "\"model\":{},",
            "\"parentId\":{},",
            "\"branchName\":{},",
            "\"totalInputTokens\":{},",
            "\"totalOutputTokens\":{}",
            "}}"
        ),
        escape_json(&summary.id),
        escape_json(&summary.title),
        option_json(summary.model.as_deref()),
        option_json(summary.parent_id.as_deref()),
        option_json(summary.branch_name.as_deref()),
        summary.total_input_tokens,
        summary.total_output_tokens
    )
}

fn parse_summary_json_line(line: &str) -> Result<SessionSummary, OctoError> {
    let id = json_string_field(line, "id").ok_or_else(|| {
        OctoError::Session(String::from("session json summary missing id"))
    })?;
    if id.is_empty() {
        return Err(OctoError::Session(String::from("session id is empty")));
    }
    Ok(SessionSummary {
        id,
        title: json_string_field(line, "title").unwrap_or_else(|| String::from("Octocode Session")),
        model: json_nullable_string_field(line, "model"),
        parent_id: json_nullable_string_field(line, "parentId"),
        branch_name: json_nullable_string_field(line, "branchName"),
        total_input_tokens: json_u32_field(line, "totalInputTokens").unwrap_or(0),
        total_output_tokens: json_u32_field(line, "totalOutputTokens").unwrap_or(0),
    })
}

fn message_to_json_line(message: &ConversationMessage) -> String {
    format!(
        "{{\"role\":\"{}\",\"content\":\"{}\"}}",
        message.role.as_str(),
        escape_json(&message.content)
    )
}

fn parse_message_json_line(line: &str) -> Option<ConversationMessage> {
    let role = json_string_field(line, "role")?;
    let content = json_string_field(line, "content")?;
    Some(ConversationMessage {
        role: ConversationRole::parse(&role),
        content,
    })
}

fn option_json(value: Option<&str>) -> String {
    match value {
        Some(value) if !value.is_empty() => format!("\"{}\"", escape_json(value)),
        _ => String::from("null"),
    }
}

fn json_nullable_string_field(input: &str, key: &str) -> Option<String> {
    if has_json_null(input, key) {
        None
    } else {
        json_string_field(input, key)
    }
}

fn has_json_null(input: &str, key: &str) -> bool {
    let needle = format!("\"{}\":null", key);
    input.contains(&needle)
}

fn json_u32_field(input: &str, key: &str) -> Option<u32> {
    let needle = format!("\"{}\":", key);
    let start = input.find(&needle)? + needle.len();
    let mut end = start;
    let bytes = input.as_bytes();
    while end < input.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    input[start..end].parse::<u32>().ok()
}

fn json_string_field(input: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = input.find(&needle)? + needle.len();
    let mut out = String::new();
    let mut escaped = false;
    for ch in input[start..].chars() {
        if escaped {
            match ch {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                other => out.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(out),
            other => out.push(other),
        }
    }
    None
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

#[cfg(test)]
mod tests {
    use super::{json_string_field, parse_message_json_line, summary_to_json_line};
    use octocode_core::{ConversationMessage, ConversationRole, SessionSummary};

    #[test]
    fn message_json_round_trip_preserves_tabs_and_newlines() {
        let line = super::message_to_json_line(&ConversationMessage {
            role: ConversationRole::User,
            content: String::from("hello\t世界\nquoted \"text\""),
        });
        let parsed = parse_message_json_line(&line).expect("message parses");
        assert_eq!(parsed.role, ConversationRole::User);
        assert_eq!(parsed.content, "hello\t世界\nquoted \"text\"");
    }

    #[test]
    fn summary_json_preserves_branch_metadata() {
        let line = summary_to_json_line(&SessionSummary {
            id: String::from("demo"),
            title: String::from("Demo"),
            model: Some(String::from("model-a")),
            parent_id: Some(String::from("root")),
            branch_name: Some(String::from("branch-a")),
            total_input_tokens: 3,
            total_output_tokens: 5,
        });
        assert_eq!(json_string_field(&line, "branchName"), Some(String::from("branch-a")));
    }
}
