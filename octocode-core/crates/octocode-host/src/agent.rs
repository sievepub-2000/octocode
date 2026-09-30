use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::provider::{ApiBackend, ModelProfile};
use crate::supervisor::{self, CompiledRule, Failure, Intervention, Supervision};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

#[derive(Debug, Clone, Deserialize)]
pub struct AgentRun {
    pub task_id: String,
    pub session_id: String,
    pub executable: PathBuf,
    pub harness_home: PathBuf,
    pub cwd: PathBuf,
    pub model: ModelProfile,
    pub prompt: String,
    pub prompt_json: Option<Value>,
    /// Empty for runs outside the desktop (the HTTP daemon), which have no workbench.
    #[serde(default)]
    pub workbench_mcp_url: String,
    #[serde(default)]
    pub workbench_mcp_token: String,
    #[serde(default)]
    pub resume: bool,
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default = "default_auto_compact_threshold_percent")]
    pub auto_compact_threshold_percent: u8,
    #[serde(default)]
    pub permission_profile: PermissionProfile,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub supervision: Supervision,
    /// Extra stdio MCP servers for runs without a workbench (the desktop reaches
    /// its MCP servers through the workbench tool hub instead).
    #[serde(default)]
    pub mcp_servers: std::collections::BTreeMap<String, StdioMcpServer>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StdioMcpServer {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// `[mcp_servers.<name>]` tables for the harness config.
fn stdio_mcp_toml(servers: &std::collections::BTreeMap<String, StdioMcpServer>) -> anyhow::Result<String> {
    let mut out = String::new();
    for (name, server) in servers {
        anyhow::ensure!(
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "invalid MCP server name: {name}"
        );
        anyhow::ensure!(!server.command.trim().is_empty(), "MCP server {name} has no command");
        out.push_str(&format!(
            "\n[mcp_servers.{name}]\ncommand = {}\nargs = {}\n",
            serde_json::to_string(&server.command)?,
            serde_json::to_string(&server.args)?
        ));
        if !server.env.is_empty() {
            out.push_str(&format!("\n[mcp_servers.{name}.env]\n"));
            for (key, value) in &server.env {
                anyhow::ensure!(key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "invalid env name: {key}");
                out.push_str(&format!("{key} = {}\n", serde_json::to_string(value)?));
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PermissionProfile {
    Review,
    Directory,
    #[default]
    Full,
}

fn harness_policy(profile: PermissionProfile, read_only: bool) -> (&'static str, &'static str, Option<&'static str>) {
    if read_only {
        // A single read-only request limits this turn's tools, not the user's permission profile.
        let mode = if profile == PermissionProfile::Full { "bypassPermissions" } else { "dontAsk" };
        (mode, READ_ONLY_RULE, Some(READ_ONLY_TOOLS))
    } else if profile == PermissionProfile::Full {
        ("bypassPermissions", VISIBLE_REASONING_RULE, None)
    } else {
        // Until approval forwarding and workspace isolation exist, never silently grant writes.
        ("dontAsk", READ_ONLY_RULE, Some(READ_ONLY_TOOLS))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentEvent {
    pub task_id: String,
    pub session_id: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Default)]
pub struct AgentManager {
    cancels: Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>,
    inputs: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>>,
}

impl AgentManager {
    pub fn start(
        &self,
        run: AgentRun,
        events: mpsc::UnboundedSender<AgentEvent>,
    ) -> anyhow::Result<String> {
        if run.auto_compact_threshold_percent > 100 {
            anyhow::bail!("auto compact threshold must be in 0..=100");
        }
        if !run.executable.is_file() {
            anyhow::bail!(
                "agent executable does not exist: {}",
                run.executable.display()
            );
        }
        if !run.cwd.is_dir() {
            anyhow::bail!("working directory does not exist: {}", run.cwd.display());
        }
        if !run.workbench_mcp_url.is_empty()
            && (!run.workbench_mcp_url.starts_with("http://127.0.0.1:")
                || run.workbench_mcp_token.trim().is_empty())
        {
            anyhow::bail!("workbench MCP endpoint is invalid");
        }
        let rules = run.supervision.stream_rules.clone().unwrap_or_else(supervisor::default_rules);
        supervisor::compile_rules(&rules)?;
        if run.task_id.trim().is_empty() || run.task_id.contains(['\r', '\n']) {
            anyhow::bail!("task id is invalid");
        }
        let task_id = run.task_id.clone();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        {
            let mut active = self.cancels.lock().expect("agent cancel lock poisoned");
            if active.contains_key(&task_id) {
                anyhow::bail!("agent task is already running: {task_id}");
            }
            active.insert(task_id.clone(), Some(cancel_tx));
        }
        let cancels = Arc::clone(&self.cancels);
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        self.inputs.lock().expect("agent input lock poisoned").insert(task_id.clone(), input_tx);
        let inputs = Arc::clone(&self.inputs);
        let spawned_id = task_id.clone();
        tokio::spawn(async move {
            if let Err(error) = run_agent(&spawned_id, &run, events.clone(), cancel_rx, input_rx).await {
                let _ = events.send(AgentEvent {
                    task_id: spawned_id.clone(),
                    session_id: run.session_id.clone(),
                    kind: "agent.error".into(),
                    payload: json!({"message": error.to_string()}),
                });
            }
            cancels
                .lock()
                .expect("agent cancel lock poisoned")
                .remove(&spawned_id);
            inputs.lock().expect("agent input lock poisoned").remove(&spawned_id);
        });
        Ok(task_id)
    }

    pub fn steer(&self, task_id: &str, input: Value) -> anyhow::Result<()> {
        anyhow::ensure!(input["id"].as_str().is_some_and(|id| !id.is_empty()), "message id is required");
        anyhow::ensure!(input["text"].is_string(), "message text is required");
        let inputs = self.inputs.lock().expect("agent input lock poisoned");
        let sender = inputs.get(task_id).ok_or_else(|| anyhow::anyhow!("agent is no longer running"))?;
        sender.send(input).map_err(|_| anyhow::anyhow!("agent input is closed"))
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        self.cancels
            .lock()
            .expect("agent cancel lock poisoned")
            .get_mut(task_id)
            .and_then(Option::take)
            .is_some_and(|sender| sender.send(()).is_ok())
    }
}

/// Drives one task through as many harness attempts as supervision allows
/// (see `supervisor` for the state machine). Emits `agent.started` once,
/// `agent.supervisor` for every intervention, and `agent.finished` once.
async fn run_agent(
    task_id: &str,
    run: &AgentRun,
    events: mpsc::UnboundedSender<AgentEvent>,
    mut cancel: oneshot::Receiver<()>,
    mut inputs: mpsc::UnboundedReceiver<Value>,
) -> anyhow::Result<()> {
    if let Some(advisor) = &run.supervision.advisor {
        supervisor::validate_advisor(advisor)?;
    }
    let rule_specs = run.supervision.stream_rules.clone().unwrap_or_else(supervisor::default_rules);
    let rules = supervisor::compile_rules(&rule_specs)?;
    let mut fired = HashSet::new();
    let mut fallbacks = run.supervision.fallbacks.iter();
    let mut model = run.model.clone();
    let mut resume = run.resume;
    let mut blocks = run.prompt_json.clone().unwrap_or_else(|| json!([{"type":"text","text":run.prompt}]));
    // --rules only applies to fresh harness sessions. Include the task boundary
    // in this turn's model input so existing conversations receive it too.
    blocks.as_array_mut().ok_or_else(|| anyhow::anyhow!("prompt_json must be an array"))?
        .push(json!({"type":"text", "text":TASK_PLAN_REMINDER}));
    let mut interventions = 0u32;
    let mut reviewed = false;
    let mut endpoint_retried = false;
    let mut tool_calls = 0u32;
    let mut tool_log = Vec::new();
    let mut attempt = 0u32;
    loop {
        // Once the intervention budget is spent, rules still observe but no longer
        // stop the attempt: killing it could only end the task as a failure.
        let may_intervene = interventions < run.supervision.max_interventions;
        let outcome = run_attempt(
            task_id, run, &model, resume, &blocks, attempt, &rules, &mut fired, may_intervene, &events, &mut cancel, &mut inputs,
        )
        .await?;
        attempt += 1;
        tool_calls += outcome.tool_calls;
        tool_log.extend(outcome.tool_log.iter().cloned());
        let budget_left = interventions < run.supervision.max_interventions;
        let next: Option<(&str, String, String)> = if outcome.cancelled {
            None
        } else if let Some(hit) = outcome.intervention.as_ref().filter(|_| budget_left) {
            interventions += 1;
            let (action, detail) = match hit {
                Intervention::Rule { id, .. } => ("rule", id.clone()),
                Intervention::Stall { call } => ("stall", call.clone()),
            };
            Some((action, detail, hit.prompt()))
        } else if !outcome.success {
            let failure = outcome.last_error.as_deref().map_or(Failure::Other, supervisor::classify_failure);
            match (failure, fallbacks.next()) {
                (Failure::Endpoint, None) if !endpoint_retried => {
                    endpoint_retried = true;
                    tokio::select! {
                        biased;
                        _ = &mut cancel => {
                            let _ = events.send(event(task_id, &run.session_id, "agent.finished",
                                json!({"success":false,"cancelled":true,"exit_code":outcome.exit_code,
                                    "attempts":attempt,"interventions":interventions})));
                            return Ok(());
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_secs(run.supervision.endpoint_retry_secs)) => {}
                    }
                    Some((
                        "endpoint_retry",
                        outcome.last_error.clone().unwrap_or_default(),
                        "[OctoCode supervisor] The model endpoint was unreachable for a moment and the session was resumed. Continue the task from where it stopped; do not restart services the session depends on unless the task requires it.".to_owned(),
                    ))
                }
                (Failure::Endpoint | Failure::ContextOverflow, Some(next_model)) => {
                    let detail = format!(
                        "{} -> {} ({})",
                        model.model,
                        next_model.model,
                        outcome.last_error.as_deref().unwrap_or("failed")
                    );
                    model = next_model.clone();
                    Some((
                        "fallback",
                        detail,
                        "[OctoCode supervisor] The previous model failed and a different model has taken over this session. Continue the task from where it stopped.".to_owned(),
                    ))
                }
                _ => None,
            }
        } else if let Some(advisor) = run.supervision.advisor.as_ref().filter(|advisor| {
            !reviewed && budget_left && tool_calls >= advisor.min_tool_calls
        }) {
            reviewed = true;
            match supervisor::review(advisor, &run.prompt, &tool_log, &outcome.final_text).await {
                Ok(Some(note)) => {
                    interventions += 1;
                    let prompt = format!(
                        "[OctoCode reviewer] {note} Address this, verify it with a tool, then give the final answer."
                    );
                    Some(("review", note, prompt))
                }
                Ok(None) => {
                    let _ = events.send(event(task_id, &run.session_id, "agent.supervisor", json!({"action": "review_ok"})));
                    None
                }
                Err(error) => {
                    let _ = events.send(event(
                        task_id,
                        &run.session_id,
                        "agent.supervisor",
                        json!({"action": "review_skipped", "detail": error.to_string()}),
                    ));
                    None
                }
            }
        } else {
            None
        };
        match next {
            Some((action, detail, prompt)) => {
                let _ = events.send(event(
                    task_id,
                    &run.session_id,
                    "agent.supervisor",
                    json!({"action": action, "detail": detail, "attempt": attempt}),
                ));
                resume = true;
                blocks = json!([{"type": "text", "text": prompt}]);
            }
            None => {
                let _ = events.send(event(
                    task_id,
                    &run.session_id,
                    "agent.finished",
                    json!({
                        "success": outcome.success, "cancelled": outcome.cancelled, "exit_code": outcome.exit_code,
                        "attempts": attempt, "interventions": interventions,
                    }),
                ));
                return Ok(());
            }
        }
    }
}

struct AttemptOutcome {
    success: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    intervention: Option<Intervention>,
    tool_calls: u32,
    tool_log: Vec<String>,
    final_text: String,
    last_error: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn run_attempt(
    task_id: &str,
    run: &AgentRun,
    model: &ModelProfile,
    resume: bool,
    blocks: &Value,
    attempt: u32,
    rules: &[CompiledRule],
    fired: &mut HashSet<String>,
    may_intervene: bool,
    events: &mpsc::UnboundedSender<AgentEvent>,
    cancel: &mut oneshot::Receiver<()>,
    inputs: &mut mpsc::UnboundedReceiver<Value>,
) -> anyhow::Result<AttemptOutcome> {
    write_harness_config(&run.harness_home, model, &run.workbench_mcp_url, run.auto_compact_threshold_percent)?;
    if !run.mcp_servers.is_empty() {
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(run.harness_home.join("config.toml"))?
            .write_all(stdio_mcp_toml(&run.mcp_servers)?.as_bytes())?;
    }
    let mut command = Command::new(&run.executable);
    let max_turns = run.max_turns.to_string();
    if resume {
        command.args(["--resume", &run.session_id]);
    } else {
        command.args(["--session-id", &run.session_id]);
    }
    // File transport avoids Windows' command-line limit for documents and images.
    // The existing harness parses .json prompt files as ACP content blocks.
    let mut prompt_file = tempfile::Builder::new().prefix("prompt-").suffix(".json").tempfile_in(&run.harness_home)?;
    serde_json::to_writer(prompt_file.as_file_mut(), blocks)?;
    command.arg("--prompt-file").arg(prompt_file.path());
    let (permission_mode, prompt_rules, allowed_tools) = harness_policy(run.permission_profile, run.read_only);
    let disallowed_tools = if allowed_tools.is_some() { READ_ONLY_DISALLOWED_TOOLS } else { XAI_ONLY_TOOLS };
    command.args([
            "--model",
            "octocode-selected",
            "--output-format",
            "streaming-json",
            "--permission-mode",
            permission_mode,
            "--max-turns",
            &max_turns,
            "--no-auto-update",
            "--todo-gate",
            // These call xAI's hosted endpoints (search, media), which no OctoCode
            // provider serves; listing them only spends context and invites failing
            // calls. `web_fetch` stays: it is a local HTTP fetch.
            "--disallowed-tools",
            disallowed_tools,
            "--rules",
            prompt_rules,
        ]);
    if let Some(tools) = allowed_tools {
        // The session allowlist clamps built-in, MCP, and subagent tools.
        command.args(["--tools", tools]);
    }
    command
        .arg("--cwd")
        .arg(&run.cwd)
        .current_dir(&run.cwd)
        .env("OCTOCODE_STEER_STDIN", "1")
        // The selected profile is authoritative; do not leak an unrelated CLI default.
        .env_remove("OPENAI_MODEL")
        .envs(harness_home_vars(&run.harness_home))
        .env("OCTOCODE_DEFAULT_SELECTED_PERMISSION", permission_mode)
        .env("OCTOCODE_AGENT_ROLE", "main")
        .env("RUST_LOG", "error")
        // Highest-precedence identity. The per-model config label is keyed by model id,
        // which adapter providers (e.g. OpenRouter) do not match, so they fell back to "Grok".
        .env("GROK_SYSTEM_PROMPT_LABEL", "OctoCode")
        .env("OCTOCODE_MEMORY_DIR", shared_memory_dir(&run.harness_home))
        // A model on the LAN must never be dialled through an HTTP proxy. A
        // system proxy (Clash and friends) swallowed those requests and the task
        // hung after the thinking text, with no answer and no error.
        .envs(no_proxy_vars(&model.base_url))
        // Do not inherit a competing machine-level threshold over the application setting.
        .env("GROK_AUTO_COMPACT_THRESHOLD_PERCENT", run.auto_compact_threshold_percent.to_string())
        .env("OCTOCODE_WORKBENCH_MCP_TOKEN", &run.workbench_mcp_token)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(api_key) = &model.api_key {
        command.env("OCTOCODE_MODEL_API_KEY", api_key);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("agent stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("agent stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("agent stderr unavailable"))?;
    let (kind, payload) = if attempt == 0 {
        ("agent.started", json!({"pid": child.id(), "started_at": chrono::Utc::now().timestamp_millis()}))
    } else {
        ("agent.supervisor", json!({"action": "attempt_started", "attempt": attempt + 1, "pid": child.id(), "model": model.model}))
    };
    let _ = events.send(event(task_id, &run.session_id, kind, payload));

    let (observed_tx, mut observed) = mpsc::unbounded_channel();
    let stdout_task = pipe_lines(
        task_id.to_owned(),
        run.session_id.clone(),
        "stdout",
        stdout,
        events.clone(),
        Some(observed_tx),
    );
    let stderr_task = pipe_lines(task_id.to_owned(), run.session_id.clone(), "stderr", stderr, events.clone(), None);
    let mut observer = supervisor::Observer::new(rules, fired);
    let mut intervention = None;
    let mut cancelled = false;
    let status = loop {
        tokio::select! {
            Some(input) = inputs.recv(), if !cancelled => {
                let line = format!("{}\n", serde_json::to_string(&input)?);
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
            }
            status = child.wait() => break status?,
            _ = &mut *cancel, if !cancelled => {
                cancelled = true;
                child.kill().await?;
            }
            Some((kind, payload)) = observed.recv() => {
                if let Some(hit) = observer.observe(&kind, &payload)
                    && may_intervene && intervention.is_none() && !cancelled
                {
                    intervention = Some(hit);
                    // The session is persisted as it streams; the next attempt resumes it.
                    child.kill().await?;
                }
            }
        }
    };
    let _ = tokio::join!(stdout_task, stderr_task);
    while let Ok((kind, payload)) = observed.try_recv() {
        let hit = observer.observe(&kind, &payload);
        if may_intervene && intervention.is_none() && !cancelled && status.success() {
            intervention = hit;
        }
    }
    drop(prompt_file);
    Ok(AttemptOutcome {
        success: status.success() && intervention.is_none(),
        cancelled,
        exit_code: status.code(),
        intervention,
        tool_calls: observer.tool_calls,
        tool_log: std::mem::take(&mut observer.tool_log),
        final_text: std::mem::take(&mut observer.final_text),
        last_error: observer.last_error.take(),
    })
}

fn pipe_lines<R>(
    task_id: String,
    session_id: String,
    stream: &'static str,
    reader: R,
    events: mpsc::UnboundedSender<AgentEvent>,
    observed: Option<mpsc::UnboundedSender<(String, Value)>>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let (kind, payload) = normalize_line(stream, &line);
            if let Some(observed) = &observed {
                let _ = observed.send((kind.clone(), payload.clone()));
            }
            if events.send(event(&task_id, &session_id, &kind, payload)).is_err() {
                break;
            }
        }
    })
}

fn normalize_line(stream: &str, line: &str) -> (String, Value) {
    match serde_json::from_str::<Value>(line) {
        Ok(payload) => {
            let kind = payload
                .get("type")
                .or_else(|| payload.get("event"))
                .and_then(Value::as_str)
                .unwrap_or("agent.output")
                .to_owned();
            (kind, payload)
        }
        Err(_) => (format!("agent.{stream}"), json!({"text": line})),
    }
}

fn event(task_id: &str, session_id: &str, kind: &str, payload: Value) -> AgentEvent {
    AgentEvent {
        task_id: task_id.into(),
        session_id: session_id.into(),
        kind: kind.into(),
        payload,
    }
}

const XAI_ONLY_TOOLS: &str = "web_search,image_gen,image_edit,image_to_video,reference_to_video";
const READ_ONLY_DISALLOWED_TOOLS: &str = "web_search,image_gen,image_edit,image_to_video,reference_to_video,use_tool,search_tool";
const READ_ONLY_TOOLS: &str = "read_file,list_dir,grep";
const READ_ONLY_RULE: &str = "此任务仅允许只读检查。不得修改文件、运行命令、调用可能改变状态的工具或执行后续实现工作。完成检查后报告发现；若用户限定报告范围或格式，最终答复只包含所要求内容。";

/// `NO_PROXY` (both spellings) covering every host in the model's base URL,
/// merged with whatever the environment already exempts.
fn no_proxy_vars(base_url: &str) -> [(&'static str, String); 2] {
    let value = no_proxy_value(base_url, std::env::var("NO_PROXY").ok().or_else(|| std::env::var("no_proxy").ok()));
    [("NO_PROXY", value.clone()), ("no_proxy", value)]
}

fn no_proxy_value(base_url: &str, inherited: Option<String>) -> String {
    let mut entries: Vec<String> = inherited
        .iter()
        .flat_map(|value| value.split(','))
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
        .collect();
    for candidate in crate::endpoint::split_candidates(base_url) {
        if let Some((host, _)) = crate::endpoint::probe_target(candidate)
            && !entries.iter().any(|entry| entry.eq_ignore_ascii_case(&host))
        {
            entries.push(host);
        }
    }
    for local in ["localhost", "127.0.0.1", "::1"] {
        if !entries.iter().any(|entry| entry.eq_ignore_ascii_case(local)) {
            entries.push(local.to_owned());
        }
    }
    entries.join(",")
}

fn default_max_turns() -> u32 {
    1_000
}

// Emitted to the model as `--rules` at session creation. Its own
// length is paid once per turn while the summaries it asks for are paid on every
// tool call. At the ~11 tok/s this hardware sustains, narrating each of twenty
// tool calls costs the user most of a minute of pure narration, so the rule asks
// for a summary where it carries information — starting a task, changing phase,
// acting on the world, changing the plan — and explicitly not around repeated
// read-only calls inside one phase.
const VISIBLE_REASONING_RULE: &str = "权限档位只决定工具可用范围，不是任务目标。每轮先遵守用户本轮的具体要求：若只要求查看、检查或分析，不得修改文件或状态，即使当前为全权限；仅在本轮明确要求修改时才执行写入。若用户限定报告范围或格式，最终答复只包含所要求内容。开始任务时、进入新阶段时、执行会改变系统状态的操作前、以及工具结果改变了你的计划时，用普通文本输出 <octo_thought>一两句面向用户的进度：当前阶段、已验证事实、下一步</octo_thought>；同一阶段内连续的只读查询不必逐次输出，阶段完成时补一句阶段进度。进度摘要不是最终答复：输出后要实际调用工具继续完成已授权的操作，不能只宣布下一步就结束；工具失败或结果为空时不得假定成功。不得输出内部逐步推理、密钥或原始协议数据。";

const TASK_PLAN_REMINDER: &str = "<system-reminder>本轮任务开始前重新判断计划需求。多步骤任务必须先用 todo_write 创建本轮待办再执行。若旧待办全部完成，用 merge=false 替换为新任务的待办；若仍有未完成事项，保留并合并调整。不要把历史已完成列表当成本轮任务的完成状态。简单问答无需建计划。</system-reminder>";


/// The variables that point the harness at its per-run home, under every name
/// the harness answers to.
///
/// `write_harness_config` puts the generated model profile in this directory,
/// and the harness resolves its home from the environment. It used to read only
/// `GROK_HOME`, so setting `OCTOCODE_HOME` alone meant the config was never
/// loaded: the harness fell back to its built-in configuration, advertised no
/// auth method for the selected model, and failed closed with "Not signed in" —
/// on a machine whose model is a local endpoint that needs no sign-in at all.
/// Reproduced outside the app against a running build.
///
/// The harness now prefers `OCTOCODE_HOME`. `GROK_HOME` is still set so an older
/// harness binary finds the same directory, and so the two sides cannot quietly
/// disagree again.
fn harness_home_vars(home: &std::path::Path) -> [(&'static str, &std::path::Path); 2] {
    [("OCTOCODE_HOME", home), ("GROK_HOME", home)]
}

fn default_auto_compact_threshold_percent() -> u8 { 90 }

/// Memory shared by every session. Each run gets its own harness home under
/// `harness-runtime/sessions/`, and memory kept inside that home was lost to the
/// next session.
fn shared_memory_dir(home: &std::path::Path) -> std::path::PathBuf {
    home.ancestors()
        .find(|dir| dir.file_name().is_some_and(|name| name == "harness-runtime"))
        .unwrap_or(home)
        .join("memory")
}

// Text-only (BM25) recall: no embedding endpoint is assumed for local models.
// The pre-compaction memory flush is off: it costs one extra model call per
// compaction (29 of them in the 32k long-task benchmark, most of its 80%
// slowdown), and session-end saves plus dream consolidation already keep
// durable memory.
const MEMORY_CONFIG: &str = r#"
[memory]
enabled = true

[memory.session]
save_on_end = true

[memory.initial_injection]
enabled = true

[compaction.memory_flush]
enabled = false
"#;

fn write_harness_config(
    home: &std::path::Path,
    model: &ModelProfile,
    workbench_mcp_url: &str,
    auto_compact_threshold_percent: u8,
) -> anyhow::Result<()> {
    // A base URL may list several addresses for the same model server, best
    // first (see `endpoint`). Resolve it here, per run, so a session started
    // while the direct cable is connected uses it and one started without it
    // falls back to Wi-Fi instead of failing.
    let base_url = crate::endpoint::select_base_url(&model.base_url);
    let model = &ModelProfile {
        base_url,
        ..model.clone()
    };
    if !model.base_url.starts_with("http://") && !model.base_url.starts_with("https://") {
        anyhow::bail!("model base_url must use http or https");
    }
    if model.model.trim().is_empty() || model.model.contains(['\r', '\n']) {
        anyhow::bail!("model id is invalid");
    }
    if !workbench_mcp_url.is_empty()
        && (!workbench_mcp_url.starts_with("http://127.0.0.1:") || workbench_mcp_url.contains(['\r', '\n']))
    {
        anyhow::bail!("workbench MCP URL is invalid");
    }
    let workbench = if workbench_mcp_url.is_empty() {
        String::new()
    } else {
        format!(
            "[mcp_servers.octocode-workbench]\nurl = {}\nbearer_token_env_var = \"OCTOCODE_WORKBENCH_MCP_TOKEN\"\n",
            serde_json::to_string(workbench_mcp_url)?
        )
    };
    std::fs::create_dir_all(home)?;
    let backend = match model.api_backend {
        ApiBackend::ChatCompletions => "chat_completions",
        ApiBackend::Responses => "responses",
        ApiBackend::Messages => "messages",
    };
    let mut thinking = String::new();
    if let Some(effort) = &model.reasoning_effort {
        thinking.push_str(&format!(
            "reasoning_effort = {}\nsupports_reasoning_effort = true\n",
            serde_json::to_string(effort)?
        ));
    }
    if let Some(body) = &model.extra_body {
        thinking.push_str(&format!("extra_body = {}\n", toml_inline(body)?));
    }
    let config = format!(
        "[features]\nremote_fetch = false\nweb_fetch = true\n\n[toolset.web_fetch]\nallowed_domains = [\"*\"]\n\n[session]\nauto_compact_threshold_percent = {auto_compact_threshold_percent}\n\n[models]\ndefault = \"octocode-selected\"\nsession_summary = \"octocode-selected\"\nimage_description = \"octocode-selected\"\nprompt_suggestion = \"octocode-selected\"\n\n[model.octocode-selected]\nmodel = {}\nname = \"OctoCode Selected Model\"\nbase_url = {}\nenv_key = \"OCTOCODE_MODEL_API_KEY\"\napi_backend = \"{backend}\"\nagent_type = \"octocode\"\nsystem_prompt_label = \"OctoCode\"\ncontext_window = {}\nmax_completion_tokens = {}\nstream_tool_calls = true\nmax_retries = 4\n{thinking}\n{workbench}{MEMORY_CONFIG}",
        serde_json::to_string(&model.model)?,
        serde_json::to_string(model.base_url.trim_end_matches('/'))?,
        model.context_window,
        model.max_completion_tokens,
    );
    let target = home.join("config.toml");
    let temporary = home.join("config.toml.tmp");
    std::fs::write(&temporary, config)?;
    if target.exists() {
        std::fs::remove_file(&target)?;
    }
    std::fs::rename(temporary, target)?;
    Ok(())
}

/// JSON value as a TOML inline value (objects become inline tables).
fn toml_inline(value: &Value) -> anyhow::Result<String> {
    Ok(match value {
        Value::Object(map) => {
            let mut fields = Vec::with_capacity(map.len());
            for (key, field) in map {
                if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    anyhow::bail!("unsupported TOML key: {key}");
                }
                fields.push(format!("{key} = {}", toml_inline(field)?));
            }
            format!("{{ {} }}", fields.join(", "))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(toml_inline).collect::<anyhow::Result<Vec<_>>>()?.join(", ")
        ),
        Value::Null => anyhow::bail!("TOML has no null"),
        // JSON strings, numbers and booleans are valid TOML literals as written.
        other => other.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_structured_and_terminal_output() {
        assert_eq!(
            normalize_line("stdout", r#"{"type":"tool_call","name":"shell"}"#).0,
            "tool_call"
        );
        let plain = normalize_line("stderr", "warning text");
        assert_eq!(plain.0, "agent.stderr");
        assert_eq!(plain.1["text"], "warning text");
    }

    #[test]
    fn default_run_budget_matches_the_desktop_runtime() {
        assert_eq!(default_max_turns(), 1_000);
    }

    #[test]
    fn duplicate_start_and_cancelling_task_keep_the_original_reservation() {
        let manager = AgentManager::default();
        let (sender, mut receiver) = oneshot::channel();
        manager.cancels.lock().unwrap().insert("active".into(), Some(sender));
        let run: AgentRun = serde_json::from_value(json!({
            "task_id":"active", "session_id":"session", "executable":std::env::current_exe().unwrap(),
            "cwd":std::env::current_dir().unwrap(), "harness_home":std::env::temp_dir(), "prompt":"test",
            "workbench_mcp_url":"http://127.0.0.1:1/mcp", "workbench_mcp_token":"fixture",
            "model":{"model":"fixture", "base_url":"http://127.0.0.1:1", "api_key":"fixture",
                "api_backend":"chat_completions", "context_window":65536, "max_completion_tokens":1000}
        })).unwrap();
        let (events, _) = mpsc::unbounded_channel();
        assert_eq!(run.auto_compact_threshold_percent, 90);
        let mut invalid = run.clone();
        invalid.auto_compact_threshold_percent = 101;
        assert!(manager.start(invalid, events.clone()).unwrap_err().to_string().contains("0..=100"));
        assert!(manager.start(run.clone(), events.clone()).unwrap_err().to_string().contains("already running"));
        assert!(manager.cancel("active"));
        assert!(receiver.try_recv().is_ok());
        assert!(!manager.cancel("active"));
        assert!(manager.start(run, events).is_err());
    }

    #[test]
    fn stdio_mcp_servers_become_valid_toml_tables() {
        let servers: std::collections::BTreeMap<String, StdioMcpServer> = serde_json::from_value(json!({
            "scrapling": {"command": "C:\\py\\python.exe", "args": ["C:\\env\\scripts\\scrapling_mcp.py"], "env": {"PYTHONUTF8": "1"}}
        }))
        .unwrap();
        let text = stdio_mcp_toml(&servers).unwrap();
        let parsed: toml::Table = toml::from_str(&text).unwrap();
        assert_eq!(parsed["mcp_servers"]["scrapling"]["command"].as_str(), Some("C:\\py\\python.exe"));
        assert_eq!(parsed["mcp_servers"]["scrapling"]["env"]["PYTHONUTF8"].as_str(), Some("1"));
        let bad: std::collections::BTreeMap<String, StdioMcpServer> =
            serde_json::from_value(json!({"a b": {"command": "x"}})).unwrap();
        assert!(stdio_mcp_toml(&bad).is_err());
    }

    #[test]
    fn maps_product_permissions_to_the_single_harness() {
        for (profile, read_only) in [(PermissionProfile::Review, false), (PermissionProfile::Directory, false)] {
            let (mode, rules, tools) = harness_policy(profile, read_only);
            assert_eq!(mode, "dontAsk");
            assert_eq!(tools, Some("read_file,list_dir,grep"));
            assert!(rules.contains("仅允许只读检查"));
        }
        let (mode, rules, tools) = harness_policy(PermissionProfile::Full, true);
        assert_eq!(mode, "bypassPermissions");
        assert_eq!(tools, Some("read_file,list_dir,grep"));
        assert!(rules.contains("仅允许只读检查"));
        assert!(rules.contains("最终答复只包含所要求内容"));
        assert!(READ_ONLY_DISALLOWED_TOOLS.contains("use_tool"));
        assert_eq!(harness_policy(PermissionProfile::Full, false), ("bypassPermissions", VISIBLE_REASONING_RULE, None));
    }

    #[test]
    fn main_agent_rule_requires_visible_progress_and_verified_recovery() {
        let rule = VISIBLE_REASONING_RULE;
        for required in [
            "<octo_thought>",
            "阶段进度",
            "不得假定成功",
            "不得输出内部逐步推理",
        ] {
            assert!(rule.contains(required), "missing rule: {required}");
        }
        // Tool names live in the harness system prompt, which renders the real ones.
        for stale in ["tools search", "ask_user", "todo_write"] {
            assert!(!rule.contains(stale), "rule must not name tools: {stale}");
        }
    }

    #[test]
    fn progress_summaries_are_scoped_to_moments_that_carry_information() {
        // Narration is generated text, and generated text is the slow part of a
        // turn on this hardware. The rule must ask for a summary where the user
        // learns something — a new phase, an action that changes the world, a
        // result that changed the plan — and must say outright that repeated
        // read-only calls inside one phase do not each need one.
        let rule = VISIBLE_REASONING_RULE;
        for required in [
            "开始任务时",
            "进入新阶段时",
            "会改变系统状态的操作前",
            "改变了你的计划时",
            "只读查询不必逐次输出",
            "进度摘要不是最终答复",
            "不能只宣布下一步就结束",
        ] {
            assert!(rule.contains(required), "missing rule: {required}");
        }
        assert!(
            !rule.contains("每次工具调用前"),
            "the rule must no longer demand a summary before every single tool call"
        );
    }


    #[test]
    fn points_the_harness_at_its_config_under_every_name_it_reads() {
        // The config the host generates is only used if the harness resolves the
        // same directory. It reads its home from the environment and understood
        // only `GROK_HOME`, so shipping `OCTOCODE_HOME` alone silently disabled
        // the whole local-model route: the harness fell back to its built-in
        // configuration and refused to start with "Not signed in".
        let home = std::path::Path::new("/tmp/harness-home");
        let vars = harness_home_vars(home);
        let names: Vec<&str> = vars.iter().map(|(name, _)| *name).collect();
        assert!(names.contains(&"OCTOCODE_HOME"), "{names:?}");
        assert!(names.contains(&"GROK_HOME"), "{names:?}");
        assert!(vars.iter().all(|(_, value)| *value == home));
    }

    #[test]
    fn thinking_controls_reach_the_harness_config() {
        let home = tempfile::tempdir().unwrap();
        let mut model = ModelProfile {
            model: "qwen".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: None,
            api_backend: ApiBackend::ChatCompletions,
            context_window: 131_072,
            max_completion_tokens: 8_192,
            reasoning_effort: Some("high".into()),
            extra_body: Some(json!({"chat_template_kwargs":{"enable_thinking":true},"thinking_budget":2048})),
        };
        write_harness_config(home.path(), &model, "http://127.0.0.1:12345/mcp", 90).unwrap();
        let config = std::fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(config.contains("reasoning_effort = \"high\"\nsupports_reasoning_effort = true\n"));
        assert!(config.contains(
            "extra_body = { chat_template_kwargs = { enable_thinking = true }, thinking_budget = 2048 }\n"
        ));
        model.reasoning_effort = None;
        model.extra_body = None;
        write_harness_config(home.path(), &model, "http://127.0.0.1:12345/mcp", 90).unwrap();
        let config = std::fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(!config.contains("reasoning_effort") && !config.contains("extra_body"));
    }

    #[test]
    fn model_hosts_bypass_any_http_proxy() {
        let value = no_proxy_value(
            "http://2.2.2.2:8000/v1, http://192.168.10.4:8000/v1",
            Some("localhost,.local".into()),
        );
        let entries: Vec<_> = value.split(',').collect();
        for host in ["2.2.2.2", "192.168.10.4", "localhost", ".local", "127.0.0.1", "::1"] {
            assert!(entries.contains(&host), "{host} missing from {value}");
        }
        assert_eq!(entries.iter().filter(|e| **e == "localhost").count(), 1);
        assert!(no_proxy_value("http://[fd00::2]:8000/v1", None).starts_with("fd00::2,"));
    }

    #[test]
    fn memory_is_shared_across_session_homes() {
        let root = std::path::Path::new("store").join("harness-runtime");
        let a = root.join("sessions").join("s-a");
        let b = root.join("sessions").join("s-b");
        assert_eq!(shared_memory_dir(&a), root.join("memory"));
        assert_eq!(shared_memory_dir(&a), shared_memory_dir(&b));
        let loose = std::path::Path::new("elsewhere");
        assert_eq!(shared_memory_dir(loose), loose.join("memory"));
    }

    #[test]
    fn writes_a_login_free_responses_profile_without_persisting_the_key() {
        let home = tempfile::tempdir().unwrap();
        let model = ModelProfile {
            reasoning_effort: None,
            extra_body: None,
            model: "qwen3.8-27b".into(),
            base_url: "http://192.168.10.2:8000/v1/".into(),
            api_key: Some("secret".into()),
            api_backend: ApiBackend::Responses,
            context_window: 262_144,
            max_completion_tokens: 32_768,
        };
        write_harness_config(home.path(), &model, "http://127.0.0.1:12345/mcp", 90).unwrap();
        let config = std::fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(config.contains("api_backend = \"responses\""));
        assert!(config.contains("agent_type = \"octocode\""));
        assert!(config.contains("system_prompt_label = \"OctoCode\""));
        assert!(config.contains("auto_compact_threshold_percent = 90"));
        assert!(config.contains("context_window = 262144"));
        assert!(config.contains("[mcp_servers.octocode-workbench]"));
        assert!(config.contains("bearer_token_env_var"));
        assert!(!config.contains("secret"));
        assert!(config.contains("[features]\nremote_fetch = false\nweb_fetch = true\n"));
        assert!(config.contains("[toolset.web_fetch]\nallowed_domains = [\"*\"]\n"));
        // A dead endpoint must surface in minutes, not after 15 retries (~25 min).
        assert!(config.contains("\nmax_retries = 4\n"));
        assert!(config.contains("\n[memory]\nenabled = true\n"));
        assert!(config.contains("\n[memory.session]\nsave_on_end = true\n"));
        assert!(config.contains("[memory.initial_injection]\nenabled = true\n"));
        assert!(config.ends_with("[compaction.memory_flush]\nenabled = false\n"));
        let parsed: toml::Table = toml::from_str(&config).unwrap_or_else(|error| panic!("invalid TOML: {error}\n{config}"));
        assert_eq!(parsed["compaction"]["memory_flush"]["enabled"], toml::Value::Boolean(false));
        write_harness_config(home.path(), &model, "", 90).unwrap();
        let standalone = std::fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(!standalone.contains("mcp_servers"), "runs without a workbench get no workbench MCP");
        assert!(toml::from_str::<toml::Table>(&standalone).is_ok());
        for threshold in [0, 70, 100] {
            write_harness_config(home.path(), &model, "http://127.0.0.1:12345/mcp", threshold).unwrap();
            let config = std::fs::read_to_string(home.path().join("config.toml")).unwrap();
            assert!(config.contains(&format!("auto_compact_threshold_percent = {threshold}")));
        }
    }

    #[test]
    fn writes_one_resolved_endpoint_when_the_model_lists_several() {
        // The direct cable to the model host is preferred over Wi-Fi, but the
        // harness only understands a single `base_url`, so exactly one address
        // must reach its config — never the raw preference list.
        let home = tempfile::tempdir().unwrap();
        let model = ModelProfile {
            reasoning_effort: None,
            extra_body: None,
            model: "qwen3.8-flash-next".into(),
            base_url: "http://10.10.10.2:8000/v1,http://192.168.10.2:8000/v1".into(),
            api_key: None,
            api_backend: ApiBackend::ChatCompletions,
            context_window: 262_144,
            max_completion_tokens: 32_768,
        };
        write_harness_config(home.path(), &model, "http://127.0.0.1:12345/mcp", 90).unwrap();
        let config = std::fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(
            !config.contains(','),
            "the preference list must be resolved before it is written: {config}"
        );
        let chosen = config
            .lines()
            .find(|line| line.starts_with("base_url = "))
            .expect("base_url line");
        assert!(
            chosen.contains("10.10.10.2:8000") || chosen.contains("192.168.10.2:8000"),
            "unexpected endpoint: {chosen}"
        );
    }
}
