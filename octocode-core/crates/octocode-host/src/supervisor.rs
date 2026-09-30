//! Supervision of one agent task across harness attempts.
//!
//! A task used to be exactly one harness process. Three failure modes made that
//! too brittle for local models, and each maps to one mechanism here:
//!
//! * the endpoint drops or the context overflows → **fallback chain**: resume the
//!   same harness session on the next configured model;
//! * the model streams a known-bad move (claims it cannot browse, calls a tool
//!   that does not exist on this machine, repeats one call in a loop) → **stream
//!   rules** (TTSR): stop the attempt and resume with a one-line correction;
//! * the model declares victory without evidence → **advisor**: a second, cheap
//!   model reviews the finished task once and may send it back with one note.
//!
//! State machine per task (the host loop in `agent.rs` drives it):
//!
//! ```text
//! Attempt ──success──► [advisor OK or skipped] ──► Finished
//!    │                  [advisor REVISE] ──────────► Attempt (resume, critique)
//!    ├──rule/stall hit──────────────────────────────► Attempt (resume, correction)
//!    ├──endpoint/context failure + fallback left ───► Attempt (resume, next model)
//!    ├──endpoint failure, no fallback, first time ──► Attempt (wait, resume, same model)
//!    └──cancel / other failure / budget spent ──────► Finished
//! ```
//!
//! Invariant: interventions (rule, stall, review) are bounded by
//! `max_interventions`, each rule and each stalled call fires at most once, and
//! every fallback model is tried at most once, so a task always terminates.

use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::provider::ModelProfile;

#[derive(Debug, Clone, Deserialize)]
pub struct Supervision {
    /// Models tried in order when the current one fails at the endpoint or
    /// overflows its context.
    #[serde(default)]
    pub fallbacks: Vec<ModelProfile>,
    /// `None` uses [`default_rules`]; `Some(vec![])` turns stream rules off.
    #[serde(default)]
    pub stream_rules: Option<Vec<StreamRule>>,
    #[serde(default)]
    pub advisor: Option<Advisor>,
    #[serde(default = "default_max_interventions")]
    pub max_interventions: u32,
    /// After the fallbacks are used up, an endpoint failure is retried once on the
    /// same model after this many seconds: a restarting or briefly unreachable
    /// server (the agent may even have restarted it itself) comes back in that time.
    #[serde(default = "default_endpoint_retry_secs")]
    pub endpoint_retry_secs: u64,
}

impl Default for Supervision {
    fn default() -> Self {
        Self {
            fallbacks: Vec::new(),
            stream_rules: None,
            advisor: None,
            max_interventions: default_max_interventions(),
            endpoint_retry_secs: default_endpoint_retry_secs(),
        }
    }
}

fn default_max_interventions() -> u32 {
    3
}

fn default_endpoint_retry_secs() -> u64 {
    30
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct StreamRule {
    pub id: String,
    pub scope: RuleScope,
    /// Regular expression, matched case-insensitively.
    pub pattern: String,
    /// Sent to the model when the rule fires.
    pub message: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleScope {
    /// Assistant text streamed since the last tool call.
    Text,
    /// A tool call's name and arguments.
    ToolInput,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Advisor {
    pub model: ModelProfile,
    /// Tasks with fewer tool calls are conversations, not work to review.
    #[serde(default = "default_min_tool_calls")]
    pub min_tool_calls: u32,
}

fn default_min_tool_calls() -> u32 {
    4
}

/// Failure patterns observed in local-model sessions on this product.
pub fn default_rules() -> Vec<StreamRule> {
    vec![
        StreamRule {
            id: "claims-offline".into(),
            scope: RuleScope::Text,
            pattern: r"(我|I)\s*(目前)?\s*(无法|不能|没有办法|can'?t|cannot|am unable to|don'?t have (the ability|access) to)\s*(直接)?\s*(访问(互联网|网络|网页|外网|网站)|联网|上网|浏览网页|browse|access the (internet|web)|search the (internet|web))".into(),
            message: "You do have network tools: `web_fetch` for pages and APIs, and the Scrapling MCP `search`/`get`/`fetch` tools, called through `octocode-workbench__tools` (`{\"action\":\"invoke\",\"kind\":\"mcp\",\"server\":\"scrapling\",\"name\":\"search\",\"arguments\":{\"query\":\"...\"}}`). Use them instead of declining.".into(),
        },
        StreamRule {
            id: "conda-env".into(),
            scope: RuleScope::ToolInput,
            pattern: r"conda\s+(run|activate)".into(),
            message: "There is no conda on this machine. Use the bundled Python: `& $env:OCTOCODE_PYTHON_BASE ...` (PowerShell) or `python` if it is on PATH.".into(),
        },
        StreamRule {
            id: "destructive-root".into(),
            scope: RuleScope::ToolInput,
            pattern: r"(rm\s+-rf\s+(/|~|\$HOME)(\s|$|\x22)|Remove-Item\s+.*-Recurse.*\s[A-Za-z]:\\?(\s|$|\x22)|format\s+[A-Za-z]:)".into(),
            message: "That command would delete a drive or home directory. Stop, and target only the specific paths the task needs.".into(),
        },
        // In a benchmark run the agent deleted its own low-confidence ARC answers;
        // an empty answer always scores zero while a wrong one costs nothing.
        StreamRule {
            id: "keep-answers".into(),
            scope: RuleScope::ToolInput,
            pattern: r"(Remove-Item|\bdel\s|\brm\s|os\.remove|unlink)[^;|\n]*answers".into(),
            message: "Do not delete answer files. Keep your best answer for every task, marked with low confidence if unsure; an empty answer always scores zero.".into(),
        },
    ]
}

pub struct CompiledRule {
    pub rule: StreamRule,
    regex: regex::Regex,
}

pub fn compile_rules(rules: &[StreamRule]) -> anyhow::Result<Vec<CompiledRule>> {
    rules
        .iter()
        .map(|rule| {
            let regex = regex::RegexBuilder::new(&rule.pattern)
                .case_insensitive(true)
                .size_limit(1 << 20)
                .build()
                .map_err(|error| anyhow::anyhow!("stream rule {}: {error}", rule.id))?;
            Ok(CompiledRule { rule: rule.clone(), regex })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intervention {
    Rule { id: String, message: String },
    Stall { call: String },
}

impl Intervention {
    pub fn prompt(&self) -> String {
        match self {
            Self::Rule { message, .. } => format!("[OctoCode supervisor] {message} Then continue the task."),
            Self::Stall { call } => format!(
                "[OctoCode supervisor] You have made the same call three times ({call}) without new progress. Stop repeating it: read the last result, change approach, then continue the task."
            ),
        }
    }
}

/// How the harness failed, as far as choosing a fallback is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Endpoint,
    ContextOverflow,
    Other,
}

pub fn classify_failure(message: &str) -> Failure {
    let lower = message.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if any(&["context length", "context_length", "maximum context", "context window", "too many tokens", "prompt is too long"]) {
        Failure::ContextOverflow
    } else if any(&[
        "temporarily unavailable",
        "connection refused",
        "connection reset",
        "error sending request",
        "timed out",
        "timeout",
        "(http 5",
        "http 50",
        "502",
        "503",
        "504",
        "429",
        "rate limit",
        "overloaded",
    ]) {
        Failure::Endpoint
    } else {
        Failure::Other
    }
}

/// Tool kinds whose repetition is waiting, not looping.
const WAIT_KINDS: &[&str] = &["background_task_action", "monitor", "kill_task_action"];

/// Watches one attempt's event stream.
pub struct Observer<'a> {
    rules: &'a [CompiledRule],
    fired: &'a mut HashSet<String>,
    text_since_tool: String,
    recent_calls: VecDeque<String>,
    pub tool_calls: u32,
    pub tool_log: Vec<String>,
    pub final_text: String,
    pub last_error: Option<String>,
}

impl<'a> Observer<'a> {
    pub fn new(rules: &'a [CompiledRule], fired: &'a mut HashSet<String>) -> Self {
        Self {
            rules,
            fired,
            text_since_tool: String::new(),
            recent_calls: VecDeque::with_capacity(4),
            tool_calls: 0,
            tool_log: Vec::new(),
            final_text: String::new(),
            last_error: None,
        }
    }

    pub fn observe(&mut self, kind: &str, payload: &Value) -> Option<Intervention> {
        match kind {
            "text" => {
                let delta = payload.get("data").and_then(Value::as_str).unwrap_or_default();
                self.text_since_tool.push_str(delta);
                self.final_text.push_str(delta);
                self.check(RuleScope::Text, &self.text_since_tool.clone())
            }
            "tool_call" => {
                self.text_since_tool.clear();
                self.final_text.clear();
                self.tool_calls += 1;
                let name = payload
                    .get("toolName")
                    .or_else(|| payload.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let input = payload.get("rawInput").map(Value::to_string).unwrap_or_default();
                let call = format!("{name} {input}");
                self.tool_log.push(truncate(&call, 200));
                if let Some(hit) = self.check(RuleScope::ToolInput, &call) {
                    return Some(hit);
                }
                self.check_stall(payload.get("kind").and_then(Value::as_str), call)
            }
            "tool_call_update" => {
                if let (Some(status), Some(last)) = (payload.get("status").and_then(Value::as_str), self.tool_log.last_mut())
                    && matches!(status, "failed" | "completed")
                    && !last.ends_with(" -> failed")
                    && !last.ends_with(" -> completed")
                {
                    last.push_str(&format!(" -> {status}"));
                }
                None
            }
            "error" => {
                self.last_error = payload.get("message").and_then(Value::as_str).map(str::to_owned);
                None
            }
            _ => None,
        }
    }

    fn check(&mut self, scope: RuleScope, haystack: &str) -> Option<Intervention> {
        let hit = self
            .rules
            .iter()
            .find(|rule| rule.rule.scope == scope && !self.fired.contains(&rule.rule.id) && rule.regex.is_match(haystack))?;
        self.fired.insert(hit.rule.id.clone());
        Some(Intervention::Rule { id: hit.rule.id.clone(), message: hit.rule.message.clone() })
    }

    fn check_stall(&mut self, kind: Option<&str>, call: String) -> Option<Intervention> {
        // Waiting on background work is polling by design: the same call repeats
        // until the command finishes. Only work calls can be a loop.
        if kind.is_some_and(|kind| WAIT_KINDS.contains(&kind)) {
            return None;
        }
        if self.recent_calls.len() == 4 {
            self.recent_calls.pop_front();
        }
        self.recent_calls.push_back(call.clone());
        let repeats = self.recent_calls.iter().filter(|previous| **previous == call).count();
        let key = format!("stall:{call}");
        if repeats >= 3 && self.fired.insert(key) {
            return Some(Intervention::Stall { call: truncate(&call, 160) });
        }
        None
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

const ADVISOR_SYSTEM: &str = "You review a coding agent's finished task. Reply with exactly `OK` when the final answer addresses the request and every claim of success (done, fixed, passing, verified) is backed by the tool calls shown. Otherwise reply `REVISE: ` followed by one or two sentences naming the specific gap and the check that would close it. Do not restate the task and do not add anything else.";

/// The advisor's verdict: `None` for OK (or no usable answer), `Some(note)` to revise.
pub async fn review(advisor: &Advisor, request: &str, tool_log: &[String], final_text: &str) -> anyhow::Result<Option<String>> {
    validate_advisor(advisor)?;
    let calls = tool_log.iter().rev().take(30).rev().cloned().collect::<Vec<_>>().join("\n");
    let user = format!(
        "Request:\n{}\n\nTool calls, in order (last 30):\n{}\n\nFinal answer:\n{}",
        truncate(request, 2_000),
        if calls.is_empty() { "(none)".into() } else { calls },
        truncate(final_text, 3_000),
    );
    let mut body = json!({
        "model": advisor.model.model,
        "messages": [{"role": "system", "content": ADVISOR_SYSTEM}, {"role": "user", "content": user}],
        "max_tokens": 200,
        "temperature": 0.2,
        "stream": false,
    });
    // Reviews must be quick: keep a template-style model out of thinking mode.
    if let Some(Value::Object(extra)) = &advisor.model.extra_body {
        for (key, value) in extra {
            body[key] = value.clone();
        }
        if body.get("chat_template_kwargs").is_some() {
            body["chat_template_kwargs"]["enable_thinking"] = json!(false);
            if let Some(object) = body.as_object_mut() {
                object.remove("thinking_budget");
            }
        }
    }
    let base_url = crate::endpoint::select_base_url(&advisor.model.base_url);
    let response = post_json(&base_url, "chat/completions", advisor.model.api_key.as_deref(), &body).await?;
    let content = response["choices"][0]["message"]["content"].as_str().unwrap_or_default().trim().to_owned();
    Ok(parse_verdict(&content))
}

pub fn validate_advisor(advisor: &Advisor) -> anyhow::Result<()> {
    if let Some(Value::Object(extra)) = &advisor.model.extra_body {
        if let Some(template) = extra.get("chat_template_kwargs") {
            anyhow::ensure!(
                template.is_object() || template.is_null(),
                "advisor chat_template_kwargs must be an object or null"
            );
        }
    }
    Ok(())
}

pub fn parse_verdict(content: &str) -> Option<String> {
    // A reasoning model may prefix `<think>…</think>`; judge only what follows it.
    let content = content.rsplit_once("</think>").map_or(content, |(_, after)| after).trim();
    let index = content.find("REVISE:")?;
    let note = content[index + "REVISE:".len()..].trim();
    (!note.is_empty()).then(|| truncate(note, 600))
}

/// Minimal HTTP/1.1 JSON POST for plain-http model servers on the LAN.
///
/// The host deliberately carries no TLS stack; an `https` advisor is reported as
/// an error and the review is skipped rather than silently weakened.
async fn post_json(base_url: &str, path: &str, api_key: Option<&str>, body: &Value) -> anyhow::Result<Value> {
    let rest = base_url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("the advisor needs a plain http endpoint, got {base_url}"))?;
    let (authority, base_path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = crate::endpoint::probe_target(base_url).ok_or_else(|| anyhow::anyhow!("invalid advisor URL {base_url}"))?;
    let target = format!("/{}/{}", base_path.trim_matches('/'), path).replace("//", "/");
    let payload = serde_json::to_vec(body)?;
    let mut request = format!(
        "POST {target} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        payload.len()
    );
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        request.push_str(&format!("Authorization: Bearer {key}\r\n"));
    }
    request.push_str("\r\n");
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
        stream.write_all(request.as_bytes()).await?;
        stream.write_all(&payload).await?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;
        anyhow::Ok(raw)
    };
    let raw = tokio::time::timeout(Duration::from_secs(120), exchange)
        .await
        .map_err(|_| anyhow::anyhow!("advisor request timed out"))??;
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("advisor response has no header terminator"))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status_ok = head.split_whitespace().nth(1).is_some_and(|code| code.starts_with('2'));
    let mut content = raw[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        content = dechunk(&content)?;
    }
    if !status_ok {
        anyhow::bail!("advisor endpoint answered: {}", truncate(&String::from_utf8_lossy(&content), 300));
    }
    Ok(serde_json::from_slice(&content)?)
}

fn dechunk(mut data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| anyhow::anyhow!("malformed chunked body"))?;
        let size_text = String::from_utf8_lossy(&data[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size + 2 {
            anyhow::bail!("truncated chunked body");
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observer_with<'a>(rules: &'a [CompiledRule], fired: &'a mut HashSet<String>) -> Observer<'a> {
        Observer::new(rules, fired)
    }

    #[test]
    fn default_rules_compile_and_fire_once_each() {
        let rules = compile_rules(&default_rules()).unwrap();
        let mut fired = HashSet::new();
        let mut observer = observer_with(&rules, &mut fired);
        let hit = observer.observe("text", &json!({"data": "抱歉，我无法访问互联网。"}));
        assert!(matches!(hit, Some(Intervention::Rule { ref id, .. }) if id == "claims-offline"));
        assert_eq!(observer.observe("text", &json!({"data": "我无法访问"})), None, "fires once per task");
        let conda = observer.observe("tool_call", &json!({"toolName": "run_terminal_command", "rawInput": {"command": "conda run -n dl python x.py"}}));
        assert!(matches!(conda, Some(Intervention::Rule { ref id, .. }) if id == "conda-env"));
        let wipe = observer.observe("tool_call", &json!({"toolName": "run_terminal_command", "rawInput": {"command": "rm -rf / --no-preserve-root"}}));
        assert!(matches!(wipe, Some(Intervention::Rule { ref id, .. }) if id == "destructive-root"));
        let delete = observer.observe("tool_call", &json!({"toolName": "run_terminal_command", "rawInput": {"command": "Remove-Item \"arc-agi-2\\answers\\4c3d4a41.json\""}}));
        assert!(matches!(delete, Some(Intervention::Rule { ref id, .. }) if id == "keep-answers"));
        let read = observer.observe("tool_call", &json!({"toolName": "run_terminal_command", "rawInput": {"command": "Get-Content bench/simpleqa/answers.json"}}));
        assert_eq!(read, None, "reading answers is fine");
    }

    #[test]
    fn ordinary_work_does_not_trip_rules() {
        let rules = compile_rules(&default_rules()).unwrap();
        let mut fired = HashSet::new();
        let mut observer = observer_with(&rules, &mut fired);
        assert_eq!(observer.observe("text", &json!({"data": "I cannot find that file, let me search for it."})), None);
        assert_eq!(observer.observe("text", &json!({"data": "我无法访问该文件，换个路径。"})), None);
        assert_eq!(
            observer.observe("tool_call", &json!({"toolName": "run_terminal_command", "rawInput": {"command": "rm -rf ./build/tmp"}})),
            None
        );
        assert_eq!(observer.tool_calls, 1);
    }

    #[test]
    fn a_call_repeated_three_times_in_four_is_a_stall_reported_once() {
        let rules = compile_rules(&[]).unwrap();
        let mut fired = HashSet::new();
        let mut observer = observer_with(&rules, &mut fired);
        let call = json!({"toolName": "read_file", "rawInput": {"path": "a.txt"}});
        assert_eq!(observer.observe("tool_call", &call), None);
        assert_eq!(observer.observe("tool_call", &json!({"toolName": "grep", "rawInput": {}})), None);
        assert_eq!(observer.observe("tool_call", &call), None);
        assert!(matches!(observer.observe("tool_call", &call), Some(Intervention::Stall { .. })));
        assert_eq!(observer.observe("tool_call", &call), None, "the same stall is reported once");
    }

    #[test]
    fn polling_background_work_is_not_a_stall() {
        let rules = compile_rules(&[]).unwrap();
        let mut fired = HashSet::new();
        let mut observer = observer_with(&rules, &mut fired);
        let poll = json!({"kind": "background_task_action", "toolName": "get_command_or_subagent_output", "rawInput": {"task_ids": ["t"]}});
        for _ in 0..6 {
            assert_eq!(observer.observe("tool_call", &poll), None);
        }
    }

    #[test]
    fn final_text_is_the_answer_after_the_last_tool_call() {
        let rules = compile_rules(&[]).unwrap();
        let mut fired = HashSet::new();
        let mut observer = observer_with(&rules, &mut fired);
        observer.observe("text", &json!({"data": "Checking."}));
        observer.observe("tool_call", &json!({"toolName": "read_file", "rawInput": {}}));
        observer.observe("tool_call_update", &json!({"status": "completed"}));
        observer.observe("text", &json!({"data": "Done: "}));
        observer.observe("text", &json!({"data": "tests pass."}));
        observer.observe("error", &json!({"message": "boom"}));
        assert_eq!(observer.final_text, "Done: tests pass.");
        assert!(observer.tool_log[0].ends_with("-> completed"));
        assert_eq!(observer.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn failures_are_classified_for_fallback() {
        assert_eq!(
            classify_failure("The model endpoint is temporarily unavailable. (HTTP 502)."),
            Failure::Endpoint
        );
        assert_eq!(classify_failure("error sending request for url"), Failure::Endpoint);
        assert_eq!(
            classify_failure("This model's maximum context length is 32768 tokens"),
            Failure::ContextOverflow
        );
        assert_eq!(classify_failure("Tool permission denied"), Failure::Other);
    }

    #[test]
    fn verdicts_are_parsed_after_any_thinking_block() {
        assert_eq!(parse_verdict("OK"), None);
        assert_eq!(parse_verdict("<think>REVISE: no</think>OK"), None);
        assert_eq!(
            parse_verdict("REVISE: The tests were never run; run pytest.").as_deref(),
            Some("The tests were never run; run pytest.")
        );
        assert_eq!(parse_verdict("REVISE:   "), None);
    }

    #[test]
    fn invalid_rule_pattern_is_rejected_with_its_id() {
        let error = compile_rules(&[StreamRule {
            id: "broken".into(),
            scope: RuleScope::Text,
            pattern: "(".into(),
            message: "x".into(),
        }])
        .err()
        .unwrap();
        assert!(error.to_string().contains("broken"));
    }

    #[test]
    fn chunked_bodies_are_reassembled() {
        assert_eq!(dechunk(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap(), b"hello world");
    }

    #[tokio::test]
    async fn advisor_round_trip_over_plain_http() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    // A reachability probe connects and closes; wait for the real request.
                    (socket, _) = listener.accept().await.unwrap();
                    raw.clear();
                    continue;
                }
                raw.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length: usize = head
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.trim().parse().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&raw).to_string();
            let reply = r#"{"choices":[{"message":{"content":"REVISE: No test was run."}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{reply}\r\n0\r\n\r\n",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });
        let advisor = Advisor {
            model: serde_json::from_value(json!({
                "model": "judge", "base_url": format!("http://{address}/v1"), "api_key": "k",
                "api_backend": "chat_completions", "context_window": 8192, "max_completion_tokens": 512,
                "extra_body": {"chat_template_kwargs": {"enable_thinking": true}, "thinking_budget": 2048}
            }))
            .unwrap(),
            min_tool_calls: 1,
        };
        let verdict = review(&advisor, "fix the bug", &["edit_file {}".into()], "Fixed.").await.unwrap();
        assert_eq!(verdict.as_deref(), Some("No test was run."));
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(request.contains("Authorization: Bearer k"));
        assert!(request.contains(r#""enable_thinking":false"#));
        assert!(!request.contains("thinking_budget"));
    }
}
