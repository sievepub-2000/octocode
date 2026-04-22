//! Multi-user workspace isolation layer.
//!
//! Provides workspace-level session isolation so multiple users (or workspaces)
//! can operate concurrently on the same server without data leakage.
//! Wraps an inner `SessionStore + ConversationStore` and prefixes all keys
//! with a workspace/user identifier.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrd};
use std::time::{SystemTime, UNIX_EPOCH};

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

use octocode_core::{
    ConversationMessage, ConversationRole, ConversationSession, ConversationStore, OctoError,
    SessionStore, SessionSummary, TurnLifecycle, TurnStateStore,
};

/// Workspace identity for isolation.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct WorkspaceId {
    /// Unique workspace identifier (e.g., hash of workspace root path).
    pub id: String,
    /// Human-readable label.
    pub label: String,
}

impl WorkspaceId {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
        }
    }

    /// Create a WorkspaceId from a filesystem path (uses last component + hash).
    pub fn from_path(path: &std::path::Path) -> Self {
        let label = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let id = format!("{:x}", simple_hash(path.to_string_lossy().as_bytes()));
        Self { id, label }
    }
}

/// Session store that isolates data per workspace.
pub struct IsolatedSessionStore {
    base_dir: PathBuf,
    active_workspace: Mutex<WorkspaceId>,
    /// Cache of workspace → sessions to avoid repeated disk reads.
    #[allow(dead_code)]
    cache: Mutex<HashMap<String, Vec<SessionSummary>>>,
}

impl IsolatedSessionStore {
    pub fn new(base_dir: PathBuf, workspace: WorkspaceId) -> Result<Self, OctoError> {
        let workspace_dir = base_dir.join(&workspace.id);
        let sessions_dir = workspace_dir.join("sessions");
        let transcripts_dir = workspace_dir.join("transcripts");

        fs::create_dir_all(&sessions_dir).map_err(|e| {
            OctoError::Session(format!("failed to create isolated sessions dir: {e}"))
        })?;
        fs::create_dir_all(&transcripts_dir).map_err(|e| {
            OctoError::Session(format!("failed to create isolated transcripts dir: {e}"))
        })?;

        Ok(Self {
            base_dir,
            active_workspace: Mutex::new(workspace),
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// Switch to a different workspace context.
    pub fn switch_workspace(&self, workspace: WorkspaceId) -> Result<(), OctoError> {
        let workspace_dir = self.base_dir.join(&workspace.id);
        fs::create_dir_all(workspace_dir.join("sessions")).map_err(|e| {
            OctoError::Session(format!("failed to create workspace sessions dir: {e}"))
        })?;
        fs::create_dir_all(workspace_dir.join("transcripts")).map_err(|e| {
            OctoError::Session(format!("failed to create workspace transcripts dir: {e}"))
        })?;
        *self.active_workspace.lock().unwrap() = workspace;
        Ok(())
    }

    /// Get the current workspace ID.
    pub fn current_workspace(&self) -> WorkspaceId {
        self.active_workspace.lock().unwrap().clone()
    }

    /// List all known workspace IDs.
    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceId>, OctoError> {
        let mut workspaces = Vec::new();
        if !self.base_dir.exists() {
            return Ok(workspaces);
        }

        for entry in fs::read_dir(&self.base_dir)
            .map_err(|e| OctoError::Session(format!("failed to read base dir: {e}")))?
        {
            let entry = entry
                .map_err(|e| OctoError::Session(format!("failed to read entry: {e}")))?;
            let path = entry.path();
            if path.is_dir() {
                let id = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                if !id.is_empty() {
                    // Try to read workspace label from metadata
                    let label = self.read_workspace_label(&path).unwrap_or_else(|| id.clone());
                    workspaces.push(WorkspaceId { id, label });
                }
            }
        }
        Ok(workspaces)
    }

    fn workspace_dir(&self) -> PathBuf {
        let ws = self.active_workspace.lock().unwrap();
        self.base_dir.join(&ws.id)
    }

    fn sessions_dir(&self) -> PathBuf {
        self.workspace_dir().join("sessions")
    }

    fn transcripts_dir(&self) -> PathBuf {
        self.workspace_dir().join("transcripts")
    }

    fn session_file(&self, id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{id}.session"))
    }

    fn transcript_file(&self, id: &str) -> PathBuf {
        self.transcripts_dir().join(format!("{id}.messages"))
    }

    fn read_workspace_label(&self, workspace_path: &std::path::Path) -> Option<String> {
        let meta_path = workspace_path.join(".workspace_label");
        fs::read_to_string(meta_path).ok().map(|s| s.trim().to_string())
    }

    /// Write workspace label metadata.
    pub fn save_workspace_label(&self) -> Result<(), OctoError> {
        let ws = self.active_workspace.lock().unwrap().clone();
        let label_path = self.base_dir.join(&ws.id).join(".workspace_label");
        fs::write(&label_path, &ws.label)
            .map_err(|e| OctoError::Session(format!("failed to save workspace label: {e}")))
    }
}

impl SessionStore for IsolatedSessionStore {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        let sessions_dir = self.sessions_dir();
        if !sessions_dir.exists() {
            return Ok(Vec::new());
        }

        let mut sessions = Vec::new();
        for entry in fs::read_dir(&sessions_dir)
            .map_err(|e| OctoError::Session(format!("failed to read sessions dir: {e}")))?
        {
            let entry = entry.map_err(|e| OctoError::Session(e.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("session") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Some(summary) = parse_session_file(&content) {
                        sessions.push(summary);
                    }
                }
            }
        }
        Ok(sessions)
    }

    fn save_session(&self, session: SessionSummary) -> Result<(), OctoError> {
        let path = self.session_file(&session.id);
        let content = format!(
            "id={}\ntitle={}\ntotal_input_tokens={}\ntotal_output_tokens={}\n",
            session.id, session.title, session.total_input_tokens, session.total_output_tokens
        );
        fs::write(&path, content)
            .map_err(|e| OctoError::Session(format!("failed to save session: {e}")))
    }
}

impl ConversationStore for IsolatedSessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        let sessions = self.list_sessions()?;
        let summary = sessions
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| OctoError::Session(format!("session not found: {id}")))?;

        let transcript_path = self.transcript_file(id);
        let messages = if transcript_path.exists() {
            let raw = fs::read_to_string(&transcript_path)
                .map_err(|e| OctoError::Session(format!("failed to read transcript: {e}")))?;
            parse_messages(&raw)
        } else {
            Vec::new()
        };

        Ok(ConversationSession {
            summary,
            messages,
            turn: TurnLifecycle::default(),
        })
    }

    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError> {
        let path = self.transcript_file(session_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| OctoError::Session(format!("failed to create transcript dir: {e}")))?;
        }
        let line = serialize_message(&message);
        let mut existing = fs::read_to_string(&path).unwrap_or_default();
        existing.push_str(&line);
        existing.push('\n');
        fs::write(&path, existing)
            .map_err(|e| OctoError::Session(format!("failed to append message: {e}")))
    }

    fn replace_messages(
        &self,
        session_id: &str,
        messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError> {
        let path = self.transcript_file(session_id);
        let content: String = messages.iter().map(|m| {
            let mut s = serialize_message(m);
            s.push('\n');
            s
        }).collect();
        fs::write(&path, content)
            .map_err(|e| OctoError::Session(format!("failed to replace messages: {e}")))
    }

    fn latest_session_id(&self) -> Result<Option<String>, OctoError> {
        let sessions = self.list_sessions()?;
        Ok(sessions.last().map(|s| s.id.clone()))
    }
}

impl TurnStateStore for IsolatedSessionStore {
    fn load_turn_state(&self, _session_id: &str) -> Result<TurnLifecycle, OctoError> {
        Ok(TurnLifecycle::default())
    }

    fn save_turn_state(&self, _session_id: &str, _turn: &TurnLifecycle) -> Result<(), OctoError> {
        Ok(())
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

fn simple_hash(data: &[u8]) -> u64 {
    let mut hash: u64 = 5381;
    for &byte in data {
        hash = hash.wrapping_mul(33).wrapping_add(byte as u64);
    }
    hash
}

fn parse_session_file(content: &str) -> Option<SessionSummary> {
    let mut id = String::new();
    let mut title = String::new();
    let mut model = None;
    let mut total_input_tokens = 0u32;
    let mut total_output_tokens = 0u32;

    for line in content.lines() {
        if let Some((key, val)) = line.split_once('=') {
            match key.trim() {
                "id" => id = val.trim().to_string(),
                "title" => title = val.trim().to_string(),
                "model" => model = Some(val.trim().to_string()).filter(|s| !s.is_empty()),
                "total_input_tokens" => total_input_tokens = val.trim().parse().unwrap_or(0),
                "total_output_tokens" => total_output_tokens = val.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    if id.is_empty() {
        return None;
    }

    Some(SessionSummary {
        id,
        title,
        model,
        parent_id: None,
        branch_name: None,
        total_input_tokens,
        total_output_tokens,
    })
}

fn serialize_message(msg: &ConversationMessage) -> String {
    let role = match msg.role {
        ConversationRole::User => "user",
        ConversationRole::Assistant => "assistant",
        ConversationRole::System => "system",
        ConversationRole::Tool => "tool",
    };
    format!("{}|{}", role, msg.content.replace('\n', "\\n"))
}

fn parse_messages(raw: &str) -> Vec<ConversationMessage> {
    raw.lines()
        .filter_map(|line| {
            let (role_str, content) = line.split_once('|')?;
            let role = match role_str {
                "user" => ConversationRole::User,
                "assistant" => ConversationRole::Assistant,
                "system" => ConversationRole::System,
                "tool" => ConversationRole::Tool,
                _ => return None,
            };
            Some(ConversationMessage {
                role,
                content: content.replace("\\n", "\n"),
            })
        })
        .collect()
}

// ─── Workspace Auth Tokens ──────────────────────────────────────────────────

/// A per-workspace authentication token.
#[derive(Debug, Clone)]
pub struct WorkspaceAuthToken {
    /// Opaque bearer token string.
    pub token: String,
    /// Workspace this token is bound to.
    pub workspace_id: String,
    /// Unix-millis when the token was issued.
    pub issued_at_ms: u128,
    /// Unix-millis when the token expires (0 = never).
    pub expires_at_ms: u128,
}

/// Manages workspace auth tokens (issue, validate, revoke).
pub struct WorkspaceTokenStore {
    tokens: Mutex<HashMap<String, WorkspaceAuthToken>>,
}

impl WorkspaceTokenStore {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Issue a new token for the given workspace.
    /// `ttl_ms` = 0 means the token never expires.
    pub fn issue(&self, workspace_id: &str, ttl_ms: u128) -> WorkspaceAuthToken {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let expires_at_ms = if ttl_ms == 0 { 0 } else { now + ttl_ms };

        // Token = hash of workspace_id + timestamp + counter
        let seq = TOKEN_COUNTER.fetch_add(1, AtomicOrd::Relaxed);
        let raw = format!("{}:{}:{}:{}", workspace_id, now, seq, simple_hash(
            format!("{}:{}:{}", workspace_id, now, seq).as_bytes(),
        ));
        let token_str = format!("{:x}", simple_hash(raw.as_bytes()));

        let token = WorkspaceAuthToken {
            token: token_str.clone(),
            workspace_id: workspace_id.to_string(),
            issued_at_ms: now,
            expires_at_ms,
        };

        self.tokens.lock().unwrap().insert(token_str, token.clone());
        token
    }

    /// Validate a bearer token and return the associated workspace ID.
    pub fn validate(&self, bearer: &str) -> Result<String, String> {
        let tokens = self.tokens.lock().unwrap();
        let token = tokens
            .get(bearer)
            .ok_or_else(|| "invalid token".to_string())?;

        if token.expires_at_ms > 0 {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            if now > token.expires_at_ms {
                return Err("token expired".to_string());
            }
        }

        Ok(token.workspace_id.clone())
    }

    /// Revoke a token.
    pub fn revoke(&self, bearer: &str) -> bool {
        self.tokens.lock().unwrap().remove(bearer).is_some()
    }

    /// Revoke all tokens for a workspace.
    pub fn revoke_workspace(&self, workspace_id: &str) -> usize {
        let mut tokens = self.tokens.lock().unwrap();
        let before = tokens.len();
        tokens.retain(|_, t| t.workspace_id != workspace_id);
        before - tokens.len()
    }

    /// Number of active tokens.
    pub fn active_count(&self) -> usize {
        self.tokens.lock().unwrap().len()
    }
}

impl Default for WorkspaceTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_iso_dir() -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let dir = env::temp_dir().join(format!("octo_iso_test_{}_{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn workspace_id_from_path() {
        let ws = WorkspaceId::from_path(std::path::Path::new("/home/user/my-project"));
        assert_eq!(ws.label, "my-project");
        assert!(!ws.id.is_empty());
    }

    #[test]
    fn isolated_store_create_and_list() {
        let dir = temp_iso_dir();
        let ws = WorkspaceId::new("ws1", "Test Workspace");
        let store = IsolatedSessionStore::new(dir.clone(), ws).unwrap();

        let sessions = store.list_sessions().unwrap();
        assert!(sessions.is_empty());

        store
            .save_session(SessionSummary {
                id: "s1".into(),
                title: "Session 1".into(),
                model: None,
                parent_id: None,
                branch_name: None,
                total_input_tokens: 100,
                total_output_tokens: 50,
            })
            .unwrap();

        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn isolated_store_workspace_isolation() {
        let dir = temp_iso_dir();
        let ws1 = WorkspaceId::new("ws1", "Workspace 1");
        let ws2 = WorkspaceId::new("ws2", "Workspace 2");

        let store = IsolatedSessionStore::new(dir.clone(), ws1.clone()).unwrap();
        store
            .save_session(SessionSummary {
                id: "s1".into(),
                title: "WS1 Session".into(),
                model: None,
                parent_id: None,
                branch_name: None,
                total_input_tokens: 0,
                total_output_tokens: 0,
            })
            .unwrap();

        // Switch to workspace 2
        store.switch_workspace(ws2).unwrap();
        let sessions = store.list_sessions().unwrap();
        assert!(sessions.is_empty()); // No sessions in ws2

        // Switch back to workspace 1
        store.switch_workspace(ws1).unwrap();
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1); // Session still in ws1

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn isolated_store_messages() {
        let dir = temp_iso_dir();
        let ws = WorkspaceId::new("ws_msg", "Msg Test");
        let store = IsolatedSessionStore::new(dir.clone(), ws).unwrap();

        store
            .save_session(SessionSummary {
                id: "chat1".into(),
                title: "Chat".into(),
                model: None,
                parent_id: None,
                branch_name: None,
                total_input_tokens: 0,
                total_output_tokens: 0,
            })
            .unwrap();

        store
            .append_message(
                "chat1",
                ConversationMessage {
                    role: ConversationRole::User,
                    content: "Hello".into(),
                },
            )
            .unwrap();
        store
            .append_message(
                "chat1",
                ConversationMessage {
                    role: ConversationRole::Assistant,
                    content: "Hi there!".into(),
                },
            )
            .unwrap();

        let session = store.load_session("chat1").unwrap();
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.messages[0].content, "Hello");
        assert_eq!(session.messages[1].content, "Hi there!");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_workspaces_empty() {
        let dir = temp_iso_dir();
        let ws = WorkspaceId::new("first", "First");
        let store = IsolatedSessionStore::new(dir.clone(), ws).unwrap();

        let workspaces = store.list_workspaces().unwrap();
        assert!(!workspaces.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn serialize_message_roundtrip() {
        let msg = ConversationMessage {
            role: ConversationRole::User,
            content: "Hello\nWorld".into(),
        };
        let serialized = serialize_message(&msg);
        assert_eq!(serialized, "user|Hello\\nWorld");

        let parsed = parse_messages(&serialized);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].content, "Hello\nWorld");
    }

    #[test]
    fn token_issue_and_validate() {
        let store = WorkspaceTokenStore::new();
        let tok = store.issue("ws-1", 0); // never expires
        assert_eq!(store.active_count(), 1);
        let ws = store.validate(&tok.token).unwrap();
        assert_eq!(ws, "ws-1");
    }

    #[test]
    fn token_revoke() {
        let store = WorkspaceTokenStore::new();
        let tok = store.issue("ws-1", 0);
        assert!(store.revoke(&tok.token));
        assert!(store.validate(&tok.token).is_err());
        assert_eq!(store.active_count(), 0);
    }

    #[test]
    fn token_revoke_workspace() {
        let store = WorkspaceTokenStore::new();
        store.issue("ws-1", 0);
        store.issue("ws-1", 0);
        store.issue("ws-2", 0);
        assert_eq!(store.active_count(), 3);
        let revoked = store.revoke_workspace("ws-1");
        assert_eq!(revoked, 2);
        assert_eq!(store.active_count(), 1);
    }

    #[test]
    fn token_invalid() {
        let store = WorkspaceTokenStore::new();
        assert!(store.validate("bogus-token").is_err());
    }

    #[test]
    fn token_expired() {
        let store = WorkspaceTokenStore::new();
        // Issue with 1ms TTL — by the time we validate it, it's expired
        let tok = store.issue("ws-1", 1);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let result = store.validate(&tok.token);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("expired"));
    }
}
