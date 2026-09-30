mod projects;
mod retention;
mod schema;

use std::path::Path;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use retention::{DEFAULT_LOG_RETENTION_DAYS, RetentionResult};
pub use projects::{Project, session_directory};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub project_id: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct LegacySessionImport {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub source_key: String,
    pub source_hash: String,
    pub messages: Vec<LegacyMessage>,
    pub events: Vec<LegacyEvent>,
}

#[derive(Deserialize)]
pub struct LegacyMessage {
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Deserialize)]
pub struct LegacyEvent {
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolRun {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub input: Value,
    pub output: Option<Value>,
    pub status: String,
    pub exit_code: Option<i64>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Artifact {
    pub id: String,
    pub session_id: Option<String>,
    pub mime_type: String,
    pub path: String,
    pub sha256: String,
    pub metadata: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowRun {
    pub id: String,
    pub session_id: String,
    pub objective: String,
    pub phase: String,
    pub status: String,
    pub state: Value,
    pub heartbeat_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogRecord {
    pub id: i64,
    pub category: String,
    pub session_id: Option<String>,
    pub tool_run_id: Option<String>,
    pub level: String,
    pub subsystem: String,
    pub message: String,
    pub fields: Value,
    pub created_at: i64,
}

pub struct Store {
    conn: Connection,
    _runtime_lock: Option<Connection>,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let path = path.as_ref();
        let runtime_lock = if path == Path::new(":memory:") {
            None
        } else {
            let mut lock_path = path.as_os_str().to_os_string();
            lock_path.push(".runtime-lock");
            let lock = Connection::open(Path::new(&lock_path))?;
            lock.busy_timeout(std::time::Duration::from_millis(100))?;
            lock.execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;")?;
            Some(lock)
        };
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        )?;
        schema::migrate(&conn)?;
        let now = Utc::now().timestamp_millis();
        let transaction = conn.unchecked_transaction()?;
        let sessions = transaction.execute(
            "UPDATE sessions SET status='interrupted',updated_at=?1 WHERE status IN ('prepared','running')",
            [now],
        )?;
        let workflows = transaction.execute(
            "UPDATE workflow_runs SET status='interrupted',heartbeat_at=?1,updated_at=?1 WHERE status='running'",
            [now],
        )?;
        let tools = transaction.execute(
            "UPDATE tool_runs SET status='interrupted',finished_at=?1 WHERE status='running'",
            [now],
        )?;
        if sessions + workflows + tools > 0 {
            transaction.execute(
                "INSERT INTO logs(category,level,subsystem,message,fields,created_at) VALUES('system','info','runtime','Recovered unfinished records after restart',?1,?2)",
                params![json!({"sessions":sessions,"workflows":workflows,"tools":tools}).to_string(), now],
            )?;
        }
        transaction.commit()?;
        Ok(Self { conn, _runtime_lock: runtime_lock })
    }

    pub fn create_session(
        &self,
        id: &str,
        title: &str,
        workspace: Option<&str>,
    ) -> rusqlite::Result<Session> {
        let now = Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO sessions(id,title,workspace,status,created_at,updated_at) VALUES (?1,?2,?3,'active',?4,?4)",
            params![id, title, workspace, now],
        )?;
        self.session(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn import_legacy_session(&self, input: LegacySessionImport) -> anyhow::Result<Value> {
        anyhow::ensure!(!input.id.is_empty() && input.id.len() <= 128, "invalid session id");
        anyhow::ensure!(!input.source_key.is_empty() && input.source_key.len() <= 4096, "invalid source key");
        anyhow::ensure!(input.source_hash.len() == 64 && input.source_hash.bytes().all(|b| b.is_ascii_hexdigit()), "invalid source hash");
        anyhow::ensure!(input.messages.len() <= 100_000 && input.events.len() <= 100_000, "legacy import record limit exceeded");
        anyhow::ensure!(input.messages.iter().all(|m| matches!(m.role.as_str(), "user" | "assistant")), "invalid legacy message role");
        anyhow::ensure!(input.events.iter().all(|e| matches!(e.kind.as_str(), "legacy.record" | "text" | "legacy.turn")), "invalid legacy event kind");
        let bytes = input.messages.iter().map(|m| m.content.len()).sum::<usize>()
            + input.events.iter().map(|e| e.payload.to_string().len()).sum::<usize>();
        anyhow::ensure!(bytes <= 64 * 1024 * 1024, "legacy import exceeds 64 MiB");
        let key = format!("legacy-import:{}", input.source_key);
        let transaction = self.conn.unchecked_transaction()?;
        let previous: Option<String> = transaction.query_row("SELECT value FROM settings WHERE key=?1", [&key], |row| row.get(0)).optional()?;
        if let Some(previous) = previous {
            let previous: Value = serde_json::from_str(&previous)?;
            anyhow::ensure!(previous["hash"] == input.source_hash, "legacy source changed; refusing to overwrite imported history");
            return Ok(json!({"imported":false,"id":previous["id"]}));
        }
        transaction.execute("INSERT INTO sessions(id,title,workspace,status,created_at,updated_at) VALUES(?1,?2,?3,'stopped',?4,?5)", params![input.id,input.title,input.workspace,input.created_at,input.updated_at])?;
        for (ordinal, message) in input.messages.iter().enumerate() {
            transaction.execute("INSERT INTO messages(id,session_id,ordinal,role,content,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![uuid::Uuid::now_v7().to_string(),input.id,ordinal as i64,message.role,message.content,message.created_at])?;
        }
        for event in input.events {
            transaction.execute("INSERT INTO events(session_id,kind,payload,created_at) VALUES(?1,?2,?3,?4)", params![input.id,event.kind,event.payload.to_string(),input.updated_at])?;
        }
        transaction.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)", params![key,json!({"id":input.id,"hash":input.source_hash}).to_string(),Utc::now().timestamp_millis()])?;
        transaction.commit()?;
        Ok(json!({"imported":true,"id":input.id}))
    }

    pub fn has_harness_checkpoint_origin(&self, session_id: &str) -> rusqlite::Result<bool> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND kind='harness.prepared')", [session_id], |row| row.get(0))
    }

    pub fn prepare_harness_session(
        &self,
        session_id: &str,
        message_id: &str,
        title: &str,
        workspace: Option<&str>,
        prompt: &str,
        event: &Value,
    ) -> rusqlite::Result<Session> {
        let task_id = event["task_id"]
            .as_str()
            .ok_or_else(|| rusqlite::Error::InvalidParameterName("event.task_id".into()))?;
        let now = Utc::now().timestamp_millis();
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO sessions(id,title,workspace,status,created_at,updated_at,model) VALUES (?1,?2,?3,'prepared',?4,?4,?5)",
            params![session_id, title, workspace, now, event["model"].as_str()],
        )?;
        transaction.execute(
            "INSERT INTO messages(id,session_id,ordinal,role,content,created_at) VALUES (?1,?2,0,'user',?3,?4)",
            params![message_id, session_id, prompt, now],
        )?;
        transaction.execute(
            "INSERT INTO events(session_id,kind,payload,created_at) VALUES (?1,'harness.prepared',?2,?3)",
            params![session_id, event.to_string(), now],
        )?;
        transaction.execute(
            "INSERT INTO workflow_runs(id,session_id,objective,phase,status,state,heartbeat_at,created_at,updated_at) VALUES(?1,?2,?3,'plan','running',?4,?5,?5,?5)",
            params![task_id, session_id, event.pointer("/handoff/objective").and_then(Value::as_str).unwrap_or(prompt), json!({"attempt":0,"verdict":Value::Null,"evidence":[],"pending":[prompt]}).to_string(), now],
        )?;
        if let Some(source) = event.pointer("/handoff/source_session_id").and_then(Value::as_str) {
            transaction.execute("INSERT INTO settings(key,value,updated_at) SELECT ?1,value,?2 FROM settings WHERE key=?3", params![format!("message-queue:{session_id}"), now, format!("message-queue:{source}")])?;
            transaction.execute("DELETE FROM settings WHERE key=?1", [format!("message-queue:{source}")])?;
            transaction.execute("INSERT INTO events(session_id,kind,payload,created_at) VALUES(?1,'harness.handed_off',?2,?3)", params![source,json!({"target_session_id":session_id,"task_id":task_id}).to_string(),now])?;
        }
        transaction.commit()?;
        self.session(session_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn continue_harness_session(
        &self,
        session_id: &str,
        message_id: &str,
        prompt: &str,
        event: &Value,
    ) -> rusqlite::Result<()> {
        let task_id = event["task_id"]
            .as_str()
            .ok_or_else(|| rusqlite::Error::InvalidParameterName("event.task_id".into()))?;
        let now = Utc::now().timestamp_millis();
        let transaction = self.conn.unchecked_transaction()?;
        let ordinal: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(ordinal),-1)+1 FROM messages WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )?;
        if transaction.execute(
            "UPDATE sessions SET status='prepared',updated_at=?2,model=COALESCE(?3,model) WHERE id=?1",
            params![session_id, now, event["model"].as_str()],
        )? != 1
        {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.execute(
            "INSERT INTO messages(id,session_id,ordinal,role,content,created_at) VALUES (?1,?2,?3,'user',?4,?5)",
            params![message_id, session_id, ordinal, prompt, now],
        )?;
        transaction.execute(
            "INSERT INTO events(session_id,kind,payload,created_at) VALUES (?1,'harness.continued',?2,?3)",
            params![session_id, event.to_string(), now],
        )?;
        transaction.execute(
            "INSERT INTO workflow_runs(id,session_id,objective,phase,status,state,heartbeat_at,created_at,updated_at) VALUES(?1,?2,?3,'plan','running',?4,?5,?5,?5)",
            params![task_id, session_id, prompt, json!({"attempt":0,"verdict":Value::Null,"evidence":[],"pending":[prompt]}).to_string(), now],
        )?;
        transaction.commit()
    }

    pub fn session(&self, id: &str) -> rusqlite::Result<Option<Session>> {
        self.conn.query_row(
            "SELECT id,title,workspace,model,status,created_at,updated_at,project_id FROM sessions WHERE id=?1",
            [id],
            |row| Ok(Session { id: row.get(0)?, title: row.get(1)?, workspace: row.get(2)?, model: row.get(3)?, status: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?, project_id: row.get(7)? }),
        ).optional()
    }

    pub fn sessions(&self) -> rusqlite::Result<Vec<Session>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,workspace,model,status,created_at,updated_at,project_id FROM sessions ORDER BY updated_at DESC",
        )?;
        stmt.query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                title: row.get(1)?,
                workspace: row.get(2)?,
                model: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                project_id: row.get(7)?,
            })
        })?
        .collect()
    }

    pub fn update_session_title(&self, id: &str, title: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute(
            "UPDATE sessions SET title=?2,updated_at=?3 WHERE id=?1",
            params![id, title, Utc::now().timestamp_millis()],
        )? == 1)
    }

    pub fn update_session_status(&self, id: &str, status: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute(
            "UPDATE sessions SET status=?2,updated_at=?3 WHERE id=?1",
            params![id, status, Utc::now().timestamp_millis()],
        )? == 1)
    }

    pub fn delete_session(&self, id: &str) -> rusqlite::Result<bool> {
        let transaction = self.conn.unchecked_transaction()?;
        let deleted = transaction.execute("DELETE FROM sessions WHERE id=?1", [id])? == 1;
        transaction.execute("DELETE FROM settings WHERE key=?1", [format!("message-queue:{id}")])?;
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn append_message(
        &self,
        id: &str,
        session_id: &str,
        role: &str,
        content: &str,
    ) -> rusqlite::Result<()> {
        let ordinal: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(ordinal),-1)+1 FROM messages WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )?;
        self.conn.execute("INSERT INTO messages(id,session_id,ordinal,role,content,created_at) VALUES (?1,?2,?3,?4,?5,?6)", params![id, session_id, ordinal, role, content, Utc::now().timestamp_millis()])?;
        Ok(())
    }

    pub fn messages(&self, session_id: &str) -> rusqlite::Result<Vec<Message>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,role,content FROM messages WHERE session_id=?1 ORDER BY ordinal")?;
        stmt.query_map([session_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
            })
        })?
        .collect()
    }

    pub fn update_message(&self, id: &str, content: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute(
            "UPDATE messages SET content=?2 WHERE id=?1",
            params![id, content],
        )? == 1)
    }

    pub fn delete_message(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM messages WHERE id=?1", [id])?
            == 1)
    }

    pub fn append_event(
        &self,
        session_id: Option<&str>,
        kind: &str,
        payload: &Value,
    ) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO events(session_id,kind,payload,created_at) VALUES (?1,?2,?3,?4)",
            params![
                session_id,
                kind,
                payload.to_string(),
                Utc::now().timestamp_millis()
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn events(
        &self,
        session_id: &str,
        after: i64,
    ) -> rusqlite::Result<Vec<(i64, String, Value)>> {
        self.event_page(session_id, after, i64::MAX, false)
    }

    pub fn event_page(
        &self,
        session_id: &str,
        after: i64,
        limit: i64,
        presentation: bool,
    ) -> rusqlite::Result<Vec<(i64, String, Value)>> {
        let mut stmt = self.conn.prepare(
            "SELECT sequence,kind,CASE WHEN ?4 AND kind IN ('tool_call_update','available_commands') THEN 'null' ELSE payload END
             FROM events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3",
        )?;
        stmt.query_map(params![session_id, after, limit, presentation], |row| {
            let raw: String = row.get(2)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                serde_json::from_str(&raw).unwrap_or(Value::Null),
            ))
        })?
        .collect()
    }

    /// Page at user-turn boundaries so history never starts halfway through a tool call.
    pub fn history_start(&self, session_id: &str, turns: i64) -> rusqlite::Result<(i64, i64)> {
        let start: Option<i64> = self.conn.query_row(
            "SELECT sequence FROM events WHERE session_id=?1 AND kind IN ('harness.prepared','harness.continued','legacy.turn')
             ORDER BY sequence DESC LIMIT 1 OFFSET ?2",
            params![session_id, turns - 1], |row| row.get(0),
        ).optional()?;
        let Some(start) = start else { return Ok((0, 0)); };
        let skipped = self.conn.query_row(
            "SELECT count(*) FROM events WHERE session_id=?1 AND sequence<?2 AND kind IN ('harness.prepared','harness.continued','legacy.turn')",
            params![session_id, start], |row| row.get(0),
        )?;
        Ok((if skipped > 0 { start - 1 } else { 0 }, skipped))
    }

    pub fn handoff_events(&self, session_id: &str) -> rusqlite::Result<Vec<(i64, String, Value)>> {
        let mut stmt = self.conn.prepare(
            "SELECT sequence,kind,payload FROM events WHERE session_id=?1
             AND kind IN ('harness.prepared','harness.continued','legacy.turn','agent.finished','plan','text') ORDER BY sequence",
        )?;
        stmt.query_map([session_id], |row| {
            let raw: String = row.get(2)?;
            Ok((row.get(0)?, row.get(1)?, serde_json::from_str(&raw).unwrap_or(Value::Null)))
        })?.collect()
    }

    pub fn handoff_destination(&self, source_session_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row(
            "SELECT session_id FROM events WHERE kind='harness.prepared' AND json_extract(payload,'$.handoff.source_session_id')=?1 LIMIT 1",
            [source_session_id], |row| row.get(0),
        ).optional()
    }

    pub fn start_tool_run(
        &self,
        id: &str,
        session_id: &str,
        name: &str,
        input: &Value,
    ) -> rusqlite::Result<ToolRun> {
        self.conn.execute(
            "INSERT INTO tool_runs(id,session_id,name,input,status,started_at) VALUES(?1,?2,?3,?4,'running',?5)",
            params![id, session_id, name, input.to_string(), Utc::now().timestamp_millis()],
        )?;
        self.tool_run(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn tool_run(&self, id: &str) -> rusqlite::Result<Option<ToolRun>> {
        self.conn.query_row(
            "SELECT id,session_id,name,input,output,status,exit_code,started_at,finished_at FROM tool_runs WHERE id=?1",
            [id],
            |row| {
                let input: String = row.get(3)?;
                let output: Option<String> = row.get(4)?;
                Ok(ToolRun {
                    id: row.get(0)?, session_id: row.get(1)?, name: row.get(2)?,
                    input: json_value(input), output: output.map(json_value), status: row.get(5)?,
                    exit_code: row.get(6)?, started_at: row.get(7)?, finished_at: row.get(8)?,
                })
            },
        ).optional()
    }

    pub fn finish_tool_run(
        &self,
        id: &str,
        status: &str,
        output: Option<&Value>,
        exit_code: Option<i64>,
    ) -> rusqlite::Result<bool> {
        Ok(self.conn.execute(
            "UPDATE tool_runs SET status=?2,output=?3,exit_code=?4,finished_at=?5 WHERE id=?1",
            params![
                id,
                status,
                output.map(Value::to_string),
                exit_code,
                Utc::now().timestamp_millis()
            ],
        )? == 1)
    }

    pub fn delete_tool_run(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM tool_runs WHERE id=?1", [id])?
            == 1)
    }

    pub fn create_artifact(
        &self,
        id: &str,
        session_id: Option<&str>,
        mime_type: &str,
        path: &str,
        sha256: &str,
        metadata: &Value,
    ) -> rusqlite::Result<Artifact> {
        self.conn.execute(
            "INSERT INTO artifacts(id,session_id,mime_type,path,sha256,metadata,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, session_id, mime_type, path, sha256, metadata.to_string(), Utc::now().timestamp_millis()],
        )?;
        self.artifact(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn artifact(&self, id: &str) -> rusqlite::Result<Option<Artifact>> {
        self.conn.query_row(
            "SELECT id,session_id,mime_type,path,sha256,metadata,created_at FROM artifacts WHERE id=?1",
            [id],
            |row| { let metadata: String = row.get(5)?; Ok(Artifact {
                id: row.get(0)?, session_id: row.get(1)?, mime_type: row.get(2)?, path: row.get(3)?,
                sha256: row.get(4)?, metadata: json_value(metadata), created_at: row.get(6)?,
            }) },
        ).optional()
    }

    pub fn update_artifact_metadata(&self, id: &str, metadata: &Value) -> rusqlite::Result<bool> {
        Ok(self.conn.execute(
            "UPDATE artifacts SET metadata=?2 WHERE id=?1",
            params![id, metadata.to_string()],
        )? == 1)
    }

    pub fn delete_artifact(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM artifacts WHERE id=?1", [id])?
            == 1)
    }

    pub fn create_workflow(
        &self,
        id: &str,
        session_id: &str,
        objective: &str,
        state: &Value,
    ) -> rusqlite::Result<WorkflowRun> {
        let now = Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO workflow_runs(id,session_id,objective,phase,status,state,heartbeat_at,created_at,updated_at) VALUES(?1,?2,?3,'plan','running',?4,?5,?5,?5)",
            params![id, session_id, objective, state.to_string(), now],
        )?;
        self.workflow(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn workflow(&self, id: &str) -> rusqlite::Result<Option<WorkflowRun>> {
        self.conn.query_row(
            "SELECT id,session_id,objective,phase,status,state,heartbeat_at,created_at,updated_at FROM workflow_runs WHERE id=?1",
            [id],
            |row| { let state: String = row.get(5)?; Ok(WorkflowRun {
                id: row.get(0)?, session_id: row.get(1)?, objective: row.get(2)?, phase: row.get(3)?,
                status: row.get(4)?, state: json_value(state), heartbeat_at: row.get(6)?,
                created_at: row.get(7)?, updated_at: row.get(8)?,
            }) },
        ).optional()
    }

    pub fn update_workflow(
        &self,
        id: &str,
        phase: &str,
        status: &str,
        state: &Value,
    ) -> rusqlite::Result<bool> {
        let now = Utc::now().timestamp_millis();
        Ok(self.conn.execute(
            "UPDATE workflow_runs SET phase=?2,status=?3,state=?4,heartbeat_at=?5,updated_at=?5 WHERE id=?1",
            params![id, phase, status, state.to_string(), now],
        )? == 1)
    }

    pub fn delete_workflow(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM workflow_runs WHERE id=?1", [id])?
            == 1)
    }

    pub fn insert_log(
        &self,
        level: &str,
        subsystem: &str,
        message: &str,
        created_at: Option<i64>,
    ) -> rusqlite::Result<i64> {
        self.insert_log_detailed(
            "developer",
            level,
            subsystem,
            message,
            &Value::Object(Default::default()),
            None,
            None,
            created_at,
        )
    }

    #[allow(clippy::too_many_arguments, reason = "direct mapping of one log row")]
    pub fn insert_log_detailed(
        &self,
        category: &str,
        level: &str,
        subsystem: &str,
        message: &str,
        fields: &Value,
        session_id: Option<&str>,
        tool_run_id: Option<&str>,
        created_at: Option<i64>,
    ) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO logs(category,session_id,tool_run_id,level,subsystem,message,fields,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                category,
                session_id,
                tool_run_id,
                level,
                subsystem,
                message,
                fields.to_string(),
                created_at.unwrap_or_else(|| Utc::now().timestamp_millis())
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn log_count(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))
    }

    pub fn logs(&self, limit: usize) -> rusqlite::Result<Vec<LogRecord>> {
        self.filtered_logs("developer", None, None, None, None, limit)
    }

    pub fn filtered_logs(
        &self,
        category: &str,
        keyword: Option<&str>,
        from: Option<i64>,
        to: Option<i64>,
        after_id: Option<i64>,
        limit: usize,
    ) -> rusqlite::Result<Vec<LogRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,category,session_id,tool_run_id,level,subsystem,message,fields,created_at
             FROM logs
             WHERE category = ?1
               AND (?2 IS NULL OR instr(lower(coalesce(level,'') || ' ' || coalesce(subsystem,'') || ' ' || coalesce(message,'') || ' ' || coalesce(fields,'') || ' ' || coalesce(session_id,'') || ' ' || coalesce(tool_run_id,'')), lower(?2)) > 0)
               AND (?3 IS NULL OR created_at >= ?3)
               AND (?4 IS NULL OR created_at < ?4)
               AND (?5 IS NULL OR id > ?5)
             ORDER BY id DESC LIMIT ?6",
        )?;
        stmt.query_map(
            params![category, keyword, from, to, after_id, limit as i64],
            |row| {
                Ok(LogRecord {
                    id: row.get(0)?,
                    category: row.get(1)?,
                    session_id: row.get(2)?,
                    tool_run_id: row.get(3)?,
                    level: row.get(4)?,
                    subsystem: row.get(5)?,
                    message: row.get(6)?,
                    fields: serde_json::from_str::<Value>(&row.get::<_, String>(7)?)
                        .unwrap_or(Value::Null),
                    created_at: row.get(8)?,
                })
            },
        )?
        .collect()
    }

    pub fn delete_log(&self, id: i64) -> rusqlite::Result<bool> {
        Ok(self.conn.execute("DELETE FROM logs WHERE id=?1", [id])? == 1)
    }

    pub fn delete_log_in_category(&self, id: i64, category: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM logs WHERE id=?1 AND category=?2",
            params![id, category],
        )? == 1)
    }

    pub fn delete_filtered_logs(
        &self,
        category: &str,
        keyword: Option<&str>,
        from: Option<i64>,
        to: Option<i64>,
    ) -> rusqlite::Result<usize> {
        self.conn.execute(
            "DELETE FROM logs
             WHERE category = ?1
               AND (?2 IS NULL OR instr(lower(coalesce(level,'') || ' ' || coalesce(subsystem,'') || ' ' || coalesce(message,'') || ' ' || coalesce(fields,'') || ' ' || coalesce(session_id,'') || ' ' || coalesce(tool_run_id,'')), lower(?2)) > 0)
               AND (?3 IS NULL OR created_at >= ?3)
               AND (?4 IS NULL OR created_at < ?4)",
            params![category, keyword, from, to],
        )
    }

    pub fn clear_logs(&self, category: &str) -> rusqlite::Result<usize> {
        self.conn
            .execute("DELETE FROM logs WHERE category=?1", [category])
    }

    pub fn purge_expired_logs(&self, retention_days: u32) -> rusqlite::Result<RetentionResult> {
        retention::purge_logs(&self.conn, retention_days)
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> rusqlite::Result<()> {
        self.conn.execute("INSERT INTO settings(key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key, value.to_string(), Utc::now().timestamp_millis()])?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> rusqlite::Result<Option<Value>> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(raw.and_then(|value| serde_json::from_str(&value).ok()))
    }

    pub fn delete_setting(&self, key: &str) -> rusqlite::Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM settings WHERE key=?1", [key])?
            == 1)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn max_event_sequence(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("SELECT COALESCE(MAX(sequence),0) FROM events", [], |row| {
                row.get(0)
            })
    }

    pub fn recent_messages(&self, limit: usize) -> rusqlite::Result<Vec<Message>> {
        let mut statement = self.conn.prepare(
            "SELECT id,role,content FROM messages ORDER BY created_at DESC,ordinal DESC LIMIT ?1",
        )?;
        statement
            .query_map([limit.min(1000) as i64], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                })
            })?
            .collect()
    }

    pub fn health(&self) -> rusqlite::Result<Value> {
        let integrity: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let journal_mode: String = self
            .conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        let user_version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(serde_json::json!({
            "ok": integrity == "ok",
            "integrity": integrity,
            "journal_mode": journal_mode,
            "user_version": user_version
        }))
    }
}

fn json_value(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}
