use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

use octocode_core::{OctoError, TaskKind, TaskRecord, TaskState, TokenInfo};

/// SQLite-backed persistent store for tasks and cost tracking.
#[derive(Clone)]
pub struct SqliteStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStore {
    /// Open (or create) the SQLite database at `workspace_root/.octocode/store.db`.
    pub fn open(workspace_root: &Path) -> Result<Self, OctoError> {
        let dir = workspace_root.join(".octocode");
        std::fs::create_dir_all(&dir)
            .map_err(|e| OctoError::Runtime(format!("sqlite mkdir: {e}")))?;
        let db_path = dir.join("store.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| OctoError::Runtime(format!("sqlite open: {e}")))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
            .map_err(|e| OctoError::Runtime(format!("sqlite pragma: {e}")))?;
        let store = Self { conn: Arc::new(Mutex::new(conn)) };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), OctoError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                session_id TEXT NOT NULL,
                label TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                created_at_ms INTEGER NOT NULL,
                finished_at_ms INTEGER,
                result_summary TEXT
            );
            CREATE TABLE IF NOT EXISTS cost_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
            CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_records(session_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(session_id UNINDEXED, segment);
            CREATE VIRTUAL TABLE IF NOT EXISTS user_search USING fts5(user_id UNINDEXED, session_id UNINDEXED, segment);",
        )
        .map_err(|e| OctoError::Runtime(format!("sqlite migrate: {e}")))?;
        Ok(())
    }

    // ── Task operations ──────────────────────────────────────────────

    pub fn insert_task(&self, rec: &TaskRecord) -> Result<(), OctoError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO tasks (id, kind, session_id, label, state, created_at_ms, finished_at_ms, result_summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                rec.id,
                task_kind_str(&rec.kind),
                rec.session_id,
                rec.label,
                task_state_str(&rec.state),
                rec.created_at_ms as i64,
                rec.finished_at_ms.map(|v| v as i64),
                rec.result_summary,
            ],
        )
        .map_err(|e| OctoError::Runtime(format!("sqlite insert task: {e}")))?;
        Ok(())
    }

    pub fn update_task_state(
        &self,
        id: &str,
        state: &TaskState,
        finished_at_ms: Option<u128>,
        summary: Option<&str>,
    ) -> Result<bool, OctoError> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute(
                "UPDATE tasks SET state=?1, finished_at_ms=?2, result_summary=?3 WHERE id=?4",
                params![
                    task_state_str(state),
                    finished_at_ms.map(|v| v as i64),
                    summary,
                    id,
                ],
            )
            .map_err(|e| OctoError::Runtime(format!("sqlite update task: {e}")))?;
        Ok(changed > 0)
    }

    pub fn list_tasks(&self, session_filter: Option<&str>) -> Result<Vec<TaskRecord>, OctoError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match session_filter {
            Some(sid) => {
                let mut s = conn
                    .prepare("SELECT id, kind, session_id, label, state, created_at_ms, finished_at_ms, result_summary FROM tasks WHERE session_id=?1 ORDER BY created_at_ms DESC")
                    .map_err(|e| OctoError::Runtime(format!("sqlite prepare: {e}")))?;
                let rows = s
                    .query_map(params![sid], row_to_task)
                    .map_err(|e| OctoError::Runtime(format!("sqlite query: {e}")))?;
                return rows
                    .filter_map(|r| r.ok())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .map(Ok)
                    .collect();
            }
            None => conn
                .prepare("SELECT id, kind, session_id, label, state, created_at_ms, finished_at_ms, result_summary FROM tasks ORDER BY created_at_ms DESC")
                .map_err(|e| OctoError::Runtime(format!("sqlite prepare: {e}")))?,
        };
        let rows = stmt
            .query_map([], row_to_task)
            .map_err(|e| OctoError::Runtime(format!("sqlite query: {e}")))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── Cost operations ──────────────────────────────────────────────

    pub fn record_cost(
        &self,
        session_id: &str,
        provider_id: &str,
        model: &str,
        tokens: &TokenInfo,
    ) -> Result<(), OctoError> {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cost_records (session_id, provider_id, model, input_tokens, output_tokens, at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, provider_id, model, tokens.input_tokens, tokens.output_tokens, at_ms],
        )
        .map_err(|e| OctoError::Runtime(format!("sqlite insert cost: {e}")))?;
        Ok(())
    }

    pub fn session_tokens(&self, session_id: &str) -> Result<TokenInfo, OctoError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0) FROM cost_records WHERE session_id=?1")
            .map_err(|e| OctoError::Runtime(format!("sqlite prepare: {e}")))?;
        let result = stmt
            .query_row(params![session_id], |row| {
                Ok(TokenInfo::new(
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                ))
            })
            .map_err(|e| OctoError::Runtime(format!("sqlite query: {e}")))?;
        Ok(result)
    }

    pub fn total_tokens(&self) -> Result<TokenInfo, OctoError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0) FROM cost_records")
            .map_err(|e| OctoError::Runtime(format!("sqlite prepare: {e}")))?;
        let result = stmt
            .query_row([], |row| {
                Ok(TokenInfo::new(
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                ))
            })
            .map_err(|e| OctoError::Runtime(format!("sqlite query: {e}")))?;
        Ok(result)
    }

    // ── Session full-text search (FTS5) ───────────────────────────
    //
    // The FTS5 virtual table is populated by callers (agent loop,
    // session resume, transcript writer) via `index_session_segment`.
    // Search returns the matching session ids together with a short
    // FTS5 snippet so the WebUI can render context-aware results.

    pub fn index_session_segment(&self, session_id: &str, segment: &str) -> Result<(), OctoError> {
        if session_id.trim().is_empty() || segment.trim().is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO session_search (session_id, segment) VALUES (?1, ?2)",
            params![session_id, segment],
        )
        .map_err(|e| OctoError::Runtime(format!("sqlite fts insert: {e}")))?;
        Ok(())
    }

    pub fn search_sessions(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(String, String)>, OctoError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT session_id, snippet(session_search, 1, '[', ']', '…', 12) AS snip \
                 FROM session_search WHERE session_search MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| OctoError::Runtime(format!("sqlite fts prepare: {e}")))?;
        let rows = stmt
            .query_map(params![trimmed, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| OctoError::Runtime(format!("sqlite fts query: {e}")))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ── Cross-session user model (FTS5 user_search) ─────────────────
    //
    // The same per-message segments are also indexed under a parallel
    // FTS5 corpus keyed by `user_id` so the runtime can answer
    // "everything <user> has ever said across every session". This is
    // the data plane behind the `@mention` router and the planned
    // user-level memory feature.

    /// Index a free-text segment under a `(user_id, session_id)` pair.
    /// Empty values are silently ignored so callers can pipe through
    /// optional ids without conditional logic.
    pub fn index_user_segment(
        &self,
        user_id: &str,
        session_id: &str,
        segment: &str,
    ) -> Result<(), OctoError> {
        if user_id.trim().is_empty()
            || session_id.trim().is_empty()
            || segment.trim().is_empty()
        {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO user_search (user_id, session_id, segment) VALUES (?1, ?2, ?3)",
            params![user_id, session_id, segment],
        )
        .map_err(|e| OctoError::Runtime(format!("sqlite user fts insert: {e}")))?;
        Ok(())
    }

    /// Full-text search restricted to the segments owned by `user_id`.
    /// Returns `(session_id, snippet)` tuples ordered by FTS5 rank.
    pub fn search_user_segments(
        &self,
        user_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(String, String)>, OctoError> {
        let q = query.trim();
        if user_id.trim().is_empty() || q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT session_id, snippet(user_search, 2, '[', ']', '…', 12) AS snip \
                 FROM user_search WHERE user_id = ?1 AND user_search MATCH ?2 \
                 ORDER BY rank LIMIT ?3",
            )
            .map_err(|e| OctoError::Runtime(format!("sqlite user fts prepare: {e}")))?;
        let rows = stmt
            .query_map(params![user_id, q, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| OctoError::Runtime(format!("sqlite user fts query: {e}")))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Aggregate every distinct session id ever seen for `user_id`.
    /// Used by the mention router as the "latest session" lookup
    /// fallback.
    pub fn sessions_for_user(&self, user_id: &str) -> Result<Vec<String>, OctoError> {
        if user_id.trim().is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT session_id FROM user_search WHERE user_id = ?1 \
                 ORDER BY rowid DESC",
            )
            .map_err(|e| OctoError::Runtime(format!("sqlite user fts prepare: {e}")))?;
        let rows = stmt
            .query_map(params![user_id], |row| row.get::<_, String>(0))
            .map_err(|e| OctoError::Runtime(format!("sqlite user fts query: {e}")))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

fn row_to_task(row: &rusqlite::Row) -> rusqlite::Result<TaskRecord> {
    Ok(TaskRecord {
        id: row.get(0)?,
        kind: parse_task_kind(&row.get::<_, String>(1)?),
        session_id: row.get(2)?,
        label: row.get(3)?,
        state: parse_task_state(&row.get::<_, String>(4)?),
        created_at_ms: row.get::<_, i64>(5)? as u128,
        finished_at_ms: row.get::<_, Option<i64>>(6)?.map(|v| v as u128),
        result_summary: row.get(7)?,
    })
}

fn task_kind_str(kind: &TaskKind) -> &'static str {
    match kind {
        TaskKind::Agent => "agent",
        TaskKind::Workflow => "workflow",
        TaskKind::Tool => "tool",
    }
}

fn parse_task_kind(s: &str) -> TaskKind {
    match s {
        "workflow" => TaskKind::Workflow,
        "tool" => TaskKind::Tool,
        _ => TaskKind::Agent,
    }
}

fn task_state_str(state: &TaskState) -> &'static str {
    match state {
        TaskState::Pending => "pending",
        TaskState::Running => "running",
        TaskState::Done => "done",
        TaskState::Failed => "failed",
    }
}

fn parse_task_state(s: &str) -> TaskState {
    match s {
        "running" => TaskState::Running,
        "done" => TaskState::Done,
        "failed" => TaskState::Failed,
        _ => TaskState::Pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> SqliteStore {
        let dir = std::env::temp_dir().join(format!(
            "octocode_sqlite_test_{}_{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        SqliteStore::open(&dir).unwrap()
    }

    #[test]
    fn task_roundtrip() {
        let store = temp_store("task_roundtrip");
        let rec = TaskRecord {
            id: String::from("t-1"),
            kind: TaskKind::Agent,
            session_id: String::from("s1"),
            label: String::from("test task"),
            state: TaskState::Pending,
            created_at_ms: 1000,
            finished_at_ms: None,
            result_summary: None,
        };
        store.insert_task(&rec).unwrap();
        let tasks = store.list_tasks(Some("s1")).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].label, "test task");

        store
            .update_task_state("t-1", &TaskState::Done, Some(2000), Some("ok"))
            .unwrap();
        let tasks = store.list_tasks(None).unwrap();
        assert_eq!(tasks[0].state, TaskState::Done);
        assert_eq!(tasks[0].result_summary.as_deref(), Some("ok"));
    }

    #[test]
    fn cost_roundtrip() {
        let store = temp_store("cost_roundtrip");
        let tokens = TokenInfo::new(100, 50);
        store.record_cost("s1", "local", "gemma", &tokens).unwrap();
        store.record_cost("s1", "local", "gemma", &tokens).unwrap();

        let session_total = store.session_tokens("s1").unwrap();
        assert_eq!(session_total.input_tokens, 200);
        assert_eq!(session_total.output_tokens, 100);

        let total = store.total_tokens().unwrap();
        assert_eq!(total.input_tokens, 200);
    }

    #[test]
    fn fts_index_and_search_round_trip() {
        let store = temp_store("fts_session_search");
        store
            .index_session_segment("s-alpha", "fixed approval token bug in workspace shell")
            .unwrap();
        store
            .index_session_segment("s-beta", "wired remote tool with shellbackend abstraction")
            .unwrap();
        store
            .index_session_segment("s-gamma", "investigated unrelated provider routing")
            .unwrap();

        let hits = store.search_sessions("shellbackend", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "s-beta");
        assert!(hits[0].1.contains("[shellbackend]"), "snippet={}", hits[0].1);

        let multi = store.search_sessions("approval OR shellbackend", 10).unwrap();
        let ids: Vec<&str> = multi.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"s-alpha"));
        assert!(ids.contains(&"s-beta"));
    }

    #[test]
    fn fts_empty_query_returns_empty() {
        let store = temp_store("fts_empty");
        store.index_session_segment("s-1", "alpha beta").unwrap();
        assert!(store.search_sessions("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn user_search_isolates_by_user_id() {
        let store = temp_store("fts_user_iso");
        store
            .index_user_segment("u-alice", "s-1", "alice prefers cargo nextest")
            .unwrap();
        store
            .index_user_segment("u-bob", "s-2", "bob prefers cargo nextest")
            .unwrap();
        let alice_hits = store.search_user_segments("u-alice", "nextest", 10).unwrap();
        assert_eq!(alice_hits.len(), 1);
        assert_eq!(alice_hits[0].0, "s-1");
        let bob_hits = store.search_user_segments("u-bob", "nextest", 10).unwrap();
        assert_eq!(bob_hits.len(), 1);
        assert_eq!(bob_hits[0].0, "s-2");
        let none = store.search_user_segments("u-charlie", "nextest", 10).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn sessions_for_user_returns_distinct_recent_first() {
        let store = temp_store("fts_user_sessions");
        store.index_user_segment("u-1", "s-old", "first").unwrap();
        store.index_user_segment("u-1", "s-new", "second").unwrap();
        store.index_user_segment("u-1", "s-new", "third").unwrap();
        let sessions = store.sessions_for_user("u-1").unwrap();
        assert_eq!(sessions, vec![String::from("s-new"), String::from("s-old")]);
        assert!(store.sessions_for_user("").unwrap().is_empty());
    }

    #[test]
    fn user_search_empty_inputs_are_silently_ignored() {
        let store = temp_store("fts_user_empty");
        store.index_user_segment("", "s-1", "x").unwrap();
        store.index_user_segment("u-1", "", "x").unwrap();
        store.index_user_segment("u-1", "s-1", "   ").unwrap();
        assert!(store.search_user_segments("u-1", "x", 10).unwrap().is_empty());
    }
}

