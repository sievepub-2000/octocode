use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    harness::{
        ContinueInput, HandoffInput, PrepareInput, TransitionInput, continue_task as continue_harness,
        prepare as prepare_harness, transition as transition_harness,
    },
    protocol::{RUNTIME_CAPABILITIES, Request, Response},
    provider::{ProviderInput, resolve as resolve_provider},
    store::{DEFAULT_LOG_RETENTION_DAYS, Store},
};

pub struct Host {
    store: Store,
}

#[derive(Deserialize)]
struct IdParam {
    id: String,
}

#[derive(Deserialize)]
struct SessionCreate {
    id: Option<String>,
    title: String,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct MessageCreate {
    id: Option<String>,
    session_id: String,
    role: String,
    content: String,
}



impl Host {
    pub fn open(path: impl AsRef<std::path::Path>) -> rusqlite::Result<Self> {
        let store = Store::open(path)?;
        let retention_days = store
            .setting("log.retention_days")?
            .and_then(|value| value.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(DEFAULT_LOG_RETENTION_DAYS);
        let purged = store.purge_expired_logs(retention_days)?;
        store.insert_log_detailed(
            "system",
            "info",
            "host",
            "OctoCode host started",
            &json!({"retention_days": retention_days, "purged_logs": purged.deleted_logs}),
            None,
            None,
            None,
        )?;
        Ok(Self { store })
    }

    pub fn record_log(
        &self,
        level: &str,
        subsystem: &str,
        message: &str,
        fields: &Value,
        session_id: Option<&str>,
    ) {
        let _ = self.store.insert_log_detailed(
            "system", level, subsystem, message, fields, session_id, None, None,
        );
    }

    fn record_developer_log(
        &self,
        level: &str,
        subsystem: &str,
        message: &str,
        fields: &Value,
        session_id: Option<&str>,
    ) {
        let _ = self.store.insert_log_detailed(
            "developer",
            level,
            subsystem,
            message,
            fields,
            session_id,
            None,
            None,
        );
    }

    pub fn record_rpc(&self, method: &str, params: &Value, response: &Response, duration_ms: u128) {
        let session_id = params.get("session_id").and_then(Value::as_str);
        let mut fields = Map::new();
        fields.insert("method".into(), json!(method));
        fields.insert("request_id".into(), response.id.clone());
        fields.insert("duration_ms".into(), json!(duration_ms));
        for key in ["task_id", "id"] {
            if let Some(value) = params.get(key).and_then(Value::as_str) {
                fields.insert(key.into(), json!(value));
            }
        }
        if let Some(error) = &response.error {
            fields.insert("error_code".into(), json!(error.code));
            self.record_developer_log(
                "error",
                "rpc",
                &format!("{method} failed: {}", error.message),
                &Value::Object(fields),
                session_id,
            );
        } else {
            self.record_developer_log(
                "info",
                "rpc",
                &format!("{method} completed"),
                &Value::Object(fields),
                session_id,
            );
        }
    }

    pub fn dispatch(&self, request: Request) -> Response {
        let id = request.id.clone();
        match self.call(&request.method, request.params) {
            Ok(result) => Response::ok(id, result),
            Err(error) => Response::error(id, error.code, error.message),
        }
    }

    pub fn record_event(
        &self,
        session_id: &str,
        kind: &str,
        payload: &Value,
    ) -> rusqlite::Result<i64> {
        self.store.append_event(Some(session_id), kind, payload)
    }

    pub fn set_session_status(&self, session_id: &str, status: &str) -> rusqlite::Result<bool> {
        self.store.update_session_status(session_id, status)
    }

    pub fn validate_agent_task(&self, task_id: &str, session_id: &str) -> anyhow::Result<()> {
        let workflow = self.store.workflow(task_id)?
            .ok_or_else(|| anyhow::anyhow!("Prepare the task before starting the agent"))?;
        anyhow::ensure!(workflow.session_id == session_id, "Task belongs to a different session");
        Ok(())
    }

    pub fn record_agent_lifecycle(
        &self,
        task_id: &str,
        session_id: &str,
        kind: &str,
        payload: &Value,
    ) -> rusqlite::Result<String> {
        let workflow = self
            .store
            .workflow(task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let accepted = workflow.state["verdict"] == "accept";
        let (phase, status) = match kind {
            "agent.started" => ("execute", "running"),
            "agent.finished" if payload["cancelled"] == true => ("stopped", "cancelled"),
            "agent.finished" if payload["success"] == true && accepted => {
                ("completed", "completed")
            }
            "agent.finished" if payload["success"] == true => ("pre_completion", "needs_review"),
            "agent.finished" | "agent.error" => ("verify", "failed"),
            _ => return Ok(workflow.status),
        };
        let mut state = workflow.state;
        state["last_event"] = json!({"kind": kind, "payload": payload});
        if status == "needs_review" {
            state["pending"] = json!(["supervisor review"]);
        }
        self.store.update_workflow(task_id, phase, status, &state)?;
        self.store.update_session_status(session_id, status)?;
        Ok(status.to_owned())
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, HostError> {
        match method {
            "capabilities.list" => Ok(json!({
                "protocol_version":1,
                "methods":RUNTIME_CAPABILITIES
            })),
            "ping" => Ok(json!({"pong": true})),
            "health" => Ok(self.store.health()?),
            "provider.resolve" => {
                let input: ProviderInput = decode(params)?;
                Ok(serde_json::to_value(resolve_provider(input)?)?)
            }
            "harness.prepare" => {
                let input: PrepareInput = decode(params)?;
                Ok(serde_json::to_value(prepare_harness(&self.store, input)?)?)
            }
            "harness.continue" => {
                let input: ContinueInput = decode(params)?;
                Ok(serde_json::to_value(continue_harness(&self.store, input)?)?)
            }
            "harness.handoff" => {
                let input: HandoffInput = decode(params)?;
                Ok(crate::harness::handoff(&self.store, input)?)
            }
            "harness.transition" => {
                let input: TransitionInput = decode(params)?;
                Ok(json!({"sequence": transition_harness(&self.store, input)?}))
            }
            "worktree.status" => {
                #[derive(Deserialize)]
                struct P {
                    cwd: std::path::PathBuf,
                }
                let p: P = decode(params)?;
                match crate::worktree::repo_root(&p.cwd) {
                    Ok(root) => Ok(json!({"isGitRepo": true, "gitRootPath": root})),
                    Err(_) => Ok(json!({"isGitRepo": false, "gitRootPath": ""})),
                }
            }
            "worktree.list" => {
                #[derive(Deserialize)]
                struct P {
                    cwd: std::path::PathBuf,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(crate::worktree::list(&p.cwd)?)?)
            }
            "worktree.create" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct P {
                    cwd: std::path::PathBuf,
                    path: std::path::PathBuf,
                    branch: Option<String>,
                    base_branch: Option<String>,
                    #[serde(default)]
                    create_new_branch: bool,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(crate::worktree::create(
                    &p.cwd,
                    &p.path,
                    p.branch.as_deref(),
                    p.base_branch.as_deref(),
                    p.create_new_branch,
                )?)?)
            }
            "worktree.delete" => {
                #[derive(Deserialize)]
                struct P {
                    cwd: std::path::PathBuf,
                    path: std::path::PathBuf,
                    #[serde(default)]
                    force: bool,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(crate::worktree::remove(
                    &p.cwd, &p.path, p.force,
                )?)?)
            }
            "worktree.branches" => {
                #[derive(Deserialize)]
                struct P {
                    cwd: std::path::PathBuf,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(crate::worktree::branches(&p.cwd)?)?)
            }
            "worktree.checkout" => {
                #[derive(Deserialize)]
                struct P {
                    cwd: std::path::PathBuf,
                    branch: String,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(crate::worktree::checkout(
                    &p.cwd, &p.branch,
                )?)?)
            }
            "supervisor.checkpoint" => {
                #[derive(Deserialize)]
                struct P {
                    id: Option<String>,
                    session_id: Option<String>,
                    objective: Option<String>,
                    phase: String,
                    attempt: u32,
                    max_attempts: u32,
                    verdict: String,
                    #[serde(default)]
                    evidence: Value,
                    #[serde(default)]
                    pending: Value,
                }
                let p: P = decode(params)?;
                if p.phase.trim().is_empty()
                    || p.max_attempts == 0
                    || !matches!(p.verdict.as_str(), "accept" | "reject")
                {
                    return Err(HostError::new(-32602, "invalid supervisor checkpoint"));
                }
                let status = match p.verdict.as_str() {
                    "accept" => "completed",
                    _ if p.attempt >= p.max_attempts => "blocked",
                    _ => "running",
                };
                let state = json!({
                    "attempt": p.attempt,
                    "max_attempts": p.max_attempts,
                    "verdict": p.verdict,
                    "evidence": p.evidence,
                    "pending": p.pending,
                });
                let id = p.id.unwrap_or_else(new_id);
                if self.store.workflow(&id)?.is_some() {
                    self.store.update_workflow(&id, &p.phase, status, &state)?;
                } else {
                    let session_id = p.session_id.ok_or_else(|| {
                        HostError::new(-32602, "new supervisor checkpoint requires session_id")
                    })?;
                    let objective = p.objective.ok_or_else(|| {
                        HostError::new(-32602, "new supervisor checkpoint requires objective")
                    })?;
                    self.store
                        .create_workflow(&id, &session_id, &objective, &state)?;
                    self.store.update_workflow(&id, &p.phase, status, &state)?;
                }
                let workflow = self.store.workflow(&id)?;
                Ok(serde_json::to_value(workflow)?)
            }
            "supervisor.resume" => {
                let p: IdParam = decode(params)?;
                Ok(serde_json::to_value(self.store.workflow(&p.id)?)?)
            }
            "supervisor.delete" => {
                let p: IdParam = decode(params)?;
                Ok(json!({"deleted": self.store.delete_workflow(&p.id)?}))
            }
            "project.list" => Ok(serde_json::to_value(self.store.projects()?)?),
            "project.index" => {
                let p: IdParam = decode(params)?;
                Ok(self.store.project_index(&p.id)?)
            }
            "project.refresh" => Ok(json!({"indexes":self.store.refresh_project_indexes()?})),
            "project.create" => {
                #[derive(Deserialize)]
                struct P { name: String, session_ids: Vec<String>, #[serde(default)] workspace: Option<String> }
                let p: P = decode(params)?;
                let project = self.store.create_project(&p.name, &p.session_ids, p.workspace.as_deref())?;
                Ok(json!({"project":project,"indexes":self.store.refresh_project_indexes()?}))
            }
            "project.assign" => {
                #[derive(Deserialize)]
                struct P { project_id: Option<String>, session_ids: Vec<String> }
                let p: P = decode(params)?;
                self.store.assign_project(&p.session_ids, p.project_id.as_deref())?;
                Ok(json!({"indexes":self.store.refresh_project_indexes()?}))
            }
            "project.rename" => {
                #[derive(Deserialize)]
                struct P { id: String, name: String }
                let p: P = decode(params)?;
                self.store.rename_project(&p.id, &p.name)?;
                Ok(json!({"indexes":self.store.refresh_project_indexes()?}))
            }
            "project.delete" => {
                let p: IdParam = decode(params)?;
                self.store.delete_project(&p.id)?;
                Ok(json!({"deleted":true}))
            }
            "session.list" => Ok(serde_json::to_value(self.store.sessions()?)?),
            "session.get" => {
                let p: IdParam = decode(params)?;
                Ok(serde_json::to_value(self.store.session(&p.id)?)?)
            }
            "session.create" => {
                let p: SessionCreate = decode(params)?;
                let id = p.id.unwrap_or_else(new_id);
                Ok(serde_json::to_value(self.store.create_session(
                    &id,
                    &p.title,
                    p.workspace.as_deref(),
                )?)?)
            }
            "session.import_legacy" => Ok(self.store.import_legacy_session(decode(params)?)?),
            "session.update" => {
                #[derive(Deserialize)]
                struct P {
                    id: String,
                    title: String,
                }
                let p: P = decode(params)?;
                Ok(json!({"updated": self.store.update_session_title(&p.id, &p.title)?}))
            }
            "session.delete" => {
                let p: IdParam = decode(params)?;
                if self.store.session(&p.id)?.is_some_and(|s| matches!(s.status.as_str(), "running" | "prepared")) {
                    return Err(anyhow::anyhow!("请先停止任务再删除会话").into());
                }
                let deleted = self.store.delete_session(&p.id)?;
                Ok(json!({"deleted":deleted,"indexes":self.store.refresh_project_indexes()?}))
            }
            "message.list" => {
                #[derive(Deserialize)]
                struct P {
                    session_id: String,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(self.store.messages(&p.session_id)?)?)
            }
            "message.append" => {
                let p: MessageCreate = decode(params)?;
                let id = p.id.unwrap_or_else(new_id);
                self.store
                    .append_message(&id, &p.session_id, &p.role, &p.content)?;
                Ok(json!({"id": id}))
            }
            "message.update" => {
                #[derive(Deserialize)]
                struct P {
                    id: String,
                    content: String,
                }
                let p: P = decode(params)?;
                Ok(json!({"updated": self.store.update_message(&p.id, &p.content)?}))
            }
            "message.delete" => {
                let p: IdParam = decode(params)?;
                Ok(json!({"deleted": self.store.delete_message(&p.id)?}))
            }
            "event.history_start" => {
                #[derive(Deserialize)]
                struct P { session_id: String, turns: i64 }
                let p: P = decode(params)?;
                if !(1..=10000).contains(&p.turns) {
                    return Err(HostError::new(-32602, "turns must be between 1 and 10000"));
                }
                let (after, skipped_turns) = self.store.history_start(&p.session_id, p.turns)?;
                Ok(json!({"after":after,"skipped_turns":skipped_turns}))
            }
            "event.list" | "event.page" => {
                #[derive(Deserialize)]
                struct P {
                    session_id: String,
                    #[serde(default)]
                    after: i64,
                    #[serde(default)]
                    presentation: bool,
                    limit: Option<i64>,
                }
                let p: P = decode(params)?;
                let limit = p.limit.unwrap_or(if method == "event.page" { 1000 } else { i64::MAX });
                if limit < 1 || (method == "event.page" && limit > 2000) || p.after < 0 {
                    return Err(HostError::new(-32602, "invalid event cursor or page size"));
                }
                let paged = method == "event.page";
                let mut rows = self.store.event_page(&p.session_id, p.after, if paged { limit + 1 } else { limit }, p.presentation)?;
                let has_more = paged && rows.len() > limit as usize;
                if has_more { rows.pop(); }
                let next = rows.last().map_or(p.after, |row| row.0);
                if paged && p.presentation {
                    let mut compacted: Vec<(i64, String, Value)> = Vec::new();
                    for row in rows {
                        if matches!(row.1.as_str(), "text" | "thought") {
                            if let Some(previous) = compacted.last_mut().filter(|previous| previous.1 == row.1) {
                                let key = if row.2.get("data").is_some() { "data" } else { "text" };
                                if previous.2.as_object().is_some_and(|value| value.keys().all(|name| name == key || name == "type"))
                                    && row.2.as_object().is_some_and(|value| value.keys().all(|name| name == key || name == "type"))
                                    && previous.2.get("type") == row.2.get("type")
                                {
                                    if let (Some(old), Some(new)) = (previous.2[key].as_str(), row.2[key].as_str()) {
                                        let joined = format!("{old}{new}");
                                        previous.2[key] = json!(joined);
                                        previous.0 = row.0;
                                        continue;
                                    }
                                }
                            }
                        }
                        compacted.push(row);
                    }
                    rows = compacted;
                }
                if paged { Ok(json!({"rows":rows,"next":next,"has_more":has_more})) }
                else { Ok(serde_json::to_value(rows)?) }
            }
            "event.append" => {
                #[derive(Deserialize)]
                struct P {
                    session_id: Option<String>,
                    kind: String,
                    payload: Value,
                }
                let p: P = decode(params)?;
                Ok(
                    json!({"sequence": self.store.append_event(p.session_id.as_deref(), &p.kind, &p.payload)?}),
                )
            }
            "log.list" => {
                #[derive(Deserialize)]
                struct P {
                    category: String,
                    #[serde(default = "default_limit")]
                    limit: usize,
                    keyword: Option<String>,
                    from: Option<i64>,
                    to: Option<i64>,
                    after_id: Option<i64>,
                }
                let p: P = decode(params)?;
                let category = log_category(&p.category)?;
                Ok(serde_json::to_value(self.store.filtered_logs(
                    category,
                    normalized_keyword(p.keyword.as_deref()),
                    p.from,
                    p.to,
                    p.after_id,
                    p.limit.min(1000),
                )?)?)
            }
            "log.create" => {
                #[derive(Deserialize)]
                struct P {
                    category: String,
                    level: String,
                    subsystem: String,
                    message: String,
                    #[serde(default)]
                    fields: Value,
                    session_id: Option<String>,
                }
                let p: P = decode(params)?;
                let category = log_category(&p.category)?;
                let id = self.store.insert_log_detailed(
                    category,
                    &p.level,
                    &p.subsystem,
                    &p.message,
                    &p.fields,
                    p.session_id.as_deref(),
                    None,
                    None,
                )?;
                Ok(json!({"id": id}))
            }
            "log.delete" => {
                #[derive(Deserialize)]
                struct P {
                    id: i64,
                    category: String,
                }
                let p: P = decode(params)?;
                let category = log_category(&p.category)?;
                Ok(json!({"deleted": self.store.delete_log_in_category(p.id, category)?}))
            }
            "log.delete_matching" => {
                #[derive(Deserialize)]
                struct P {
                    category: String,
                    keyword: Option<String>,
                    from: Option<i64>,
                    to: Option<i64>,
                }
                let p: P = decode(params)?;
                let category = log_category(&p.category)?;
                let keyword = normalized_keyword(p.keyword.as_deref());
                if keyword.is_none() && p.from.is_none() && p.to.is_none() {
                    return Err(HostError::new(
                        -32602,
                        "at least one log filter is required",
                    ));
                }
                Ok(json!({"deleted": self.store.delete_filtered_logs(
                    category, keyword, p.from, p.to
                )?}))
            }
            "log.clear" => {
                #[derive(Deserialize)]
                struct P {
                    category: String,
                }
                let p: P = decode(params)?;
                Ok(json!({"deleted": self.store.clear_logs(log_category(&p.category)?)?}))
            }
            "log.purge" => {
                #[derive(Deserialize)]
                struct P {
                    #[serde(default = "default_retention")]
                    retention_days: u32,
                }
                let p: P = decode(params)?;
                Ok(serde_json::to_value(
                    self.store.purge_expired_logs(p.retention_days)?,
                )?)
            }
            "setting.get" => {
                #[derive(Deserialize)]
                struct P {
                    key: String,
                }
                let p: P = decode(params)?;
                Ok(self.store.setting(&p.key)?.unwrap_or(Value::Null))
            }
            "setting.set" => {
                #[derive(Deserialize)]
                struct P {
                    key: String,
                    value: Value,
                }
                let p: P = decode(params)?;
                self.store.set_setting(&p.key, &p.value)?;
                Ok(json!({"updated": true}))
            }
            "setting.delete" => {
                #[derive(Deserialize)]
                struct P {
                    key: String,
                }
                let p: P = decode(params)?;
                Ok(json!({"deleted": self.store.delete_setting(&p.key)?}))
            }
            _ => Err(HostError::new(-32601, "method not found")),
        }
    }
}

struct HostError {
    code: i32,
    message: String,
}

impl HostError {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for HostError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(-32000, error.to_string())
    }
}

impl From<serde_json::Error> for HostError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(-32602, error.to_string())
    }
}

impl From<anyhow::Error> for HostError {
    fn from(error: anyhow::Error) -> Self {
        Self::new(-32602, error.to_string())
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, HostError> {
    Ok(serde_json::from_value(value)?)
}
fn new_id() -> String {
    Uuid::now_v7().to_string()
}
fn default_limit() -> usize {
    100
}
fn default_retention() -> u32 {
    DEFAULT_LOG_RETENTION_DAYS
}
fn normalized_keyword(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
fn log_category(value: &str) -> Result<&str, HostError> {
    match value {
        "system" | "developer" => Ok(value),
        _ => Err(HostError::new(
            -32602,
            "category must be system or developer",
        )),
    }
}

