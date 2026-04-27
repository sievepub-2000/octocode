use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use octocode_core::{ConversationRole, PermissionMode, PromptRequest, ToolCall};

use crate::server::AppRuntime;

const DEFAULT_MAX_STEPS: usize = 8;
const HARD_MAX_STEPS: usize = 25;

#[derive(Debug, Clone)]
struct LoopStep {
    phase: String,
    tool: String,
    input: String,
    source: DecisionSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DecisionSource {
    Model,
    Fallback,
}

#[derive(Debug, Clone)]
struct StepObservation {
    step_index: usize,
    tool: String,
    input: String,
    ok: bool,
    output: String,
}

pub fn run_agent_loop_cli(
    runtime: &mut AppRuntime,
    session_id: &str,
    goal: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let (goal, max_steps) = parse_goal_and_max_steps(goal);
    let data_home = runtime.config_paths().data_home;

    runtime.append_session_message(
        session_id,
        ConversationRole::System,
        format!(
            "agent-loop auto start: goal={} maxSteps={} mode=model-decide-with-fallback",
            goal, max_steps
        ),
    )?;

    println!("agent-loop start session={} maxSteps={} goal={}", session_id, max_steps, goal);

    let mut observations: Vec<StepObservation> = Vec::new();
    let mut lines = vec![
        format!("agent-loop auto executed for: {goal}"),
        format!("maxSteps={max_steps}"),
    ];
    let mut stopped_reason = String::from("max steps reached");

    for step_index in 1..=max_steps {
        let decision = decide_next_step(runtime, session_id, &goal, step_index, &observations);
        if decision.tool == "done" {
            stopped_reason = if decision.input.trim().is_empty() {
                String::from("model decided done")
            } else {
                format!("done: {}", decision.input)
            };
            println!("agent-loop step={} done reason={}", step_index, stopped_reason);
            runtime.append_session_message(
                session_id,
                ConversationRole::Assistant,
                format!("agent-loop done: {stopped_reason}"),
            )?;
            break;
        }

        println!(
            "agent-loop step={} phase={} tool={} source={:?}",
            step_index, decision.phase, decision.tool, decision.source
        );
        runtime.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!(
                "agent-loop step={} phase={} tool={} source={:?} input={}",
                step_index,
                decision.phase,
                decision.tool,
                decision.source,
                if decision.input.is_empty() { "<empty>" } else { &decision.input }
            ),
        )?;

        audit_if_high_permission(&data_home, session_id, &decision.tool, &decision.input)?;

        let result = runtime.run_tool_in_session(
            session_id,
            ToolCall {
                name: decision.tool.clone(),
                input: decision.input.clone(),
                permission: PermissionMode::ReadOnly,
            },
        );

        match result {
            Ok(result) => {
                let output = clip_output(&result.output, 1600);
                println!(
                    "agent-loop step={} ok outputChars={}",
                    step_index,
                    result.output.chars().count()
                );
                runtime.append_session_message(
                    session_id,
                    ConversationRole::Tool,
                    format!("agent-loop observation step={} => {}", step_index, output),
                )?;
                observations.push(StepObservation {
                    step_index,
                    tool: decision.tool.clone(),
                    input: decision.input.clone(),
                    ok: true,
                    output,
                });
                lines.push(format!(
                    "step.{} {} {} ok source={:?}",
                    step_index, decision.phase, decision.tool, decision.source
                ));
            }
            Err(error) => {
                stopped_reason = format!("step {step_index} failed on {}: {error}", decision.tool);
                println!("agent-loop step={} failed error={}", step_index, error);
                runtime.append_session_message(
                    session_id,
                    ConversationRole::System,
                    stopped_reason.clone(),
                )?;
                observations.push(StepObservation {
                    step_index,
                    tool: decision.tool.clone(),
                    input: decision.input.clone(),
                    ok: false,
                    output: error.to_string(),
                });
                lines.push(format!(
                    "step.{} {} {} failed source={:?} error={}",
                    step_index, decision.phase, decision.tool, decision.source, error
                ));
                break;
            }
        }

        if should_stop_after_step(&goal, &observations) {
            stopped_reason = String::from("goal appears satisfied by validation signal");
            println!("agent-loop stop reason={}", stopped_reason);
            break;
        }
    }

    lines.push(format!("stopped={stopped_reason}"));
    let summary = lines.join("\n");
    runtime.append_session_message(
        session_id,
        ConversationRole::Assistant,
        summary.clone(),
    )?;
    Ok(summary)
}

fn decide_next_step(
    runtime: &mut AppRuntime,
    session_id: &str,
    goal: &str,
    step_index: usize,
    observations: &[StepObservation],
) -> LoopStep {
    let prompt = build_decision_prompt(session_id, goal, step_index, observations);
    match runtime.prompt(PromptRequest {
        text: prompt,
        model: runtime.config().default_model.clone(),
    }) {
        Ok(response) => parse_model_decision(&response.output)
            .unwrap_or_else(|| fallback_decision(goal, step_index, observations)),
        Err(_) => fallback_decision(goal, step_index, observations),
    }
}

fn build_decision_prompt(
    session_id: &str,
    goal: &str,
    step_index: usize,
    observations: &[StepObservation],
) -> String {
    let history = observations
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|obs| {
            format!(
                "step={} tool={} ok={} input={} output={} ",
                obs.step_index,
                obs.tool,
                obs.ok,
                obs.input,
                clip_output(&obs.output, 500)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        concat!(
            "You are Octocode's local agent loop controller.\n",
            "Choose exactly one next tool call for this bounded loop.\n",
            "Return only lines in this exact format:\n",
            "tool=<one of read-context,file-tree,read-file,search-text,workflow-plan,git-status,git-diff,write-file,append-file,shell-command,done>\n",
            "input=<tool input, or reason if done>\n",
            "phase=<observe|inspect|plan|act|validate|done>\n\n",
            "Rules:\n",
            "- Prefer read-context/file-tree/search-text/read-file before writing.\n",
            "- Use write-file/append-file/shell-command only if the goal explicitly requires mutation or command execution.\n",
            "- If the last validation is enough, choose tool=done.\n",
            "- Do not invent unsupported tools.\n\n",
            "session={}\n",
            "goal={}\n",
            "stepIndex={}\n",
            "recentObservations:\n{}\n"
        ),
        session_id,
        goal,
        step_index,
        if history.is_empty() { "<none>" } else { &history }
    )
}

fn parse_model_decision(output: &str) -> Option<LoopStep> {
    let mut tool = None;
    let mut input = String::new();
    let mut phase = None;

    for line in output.lines() {
        let trimmed = line.trim().trim_matches('`');
        if let Some(value) = trimmed.strip_prefix("tool=") {
            tool = Some(value.trim().to_string());
        } else if let Some(value) = trimmed.strip_prefix("input=") {
            input = value.trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("phase=") {
            phase = Some(value.trim().to_string());
        }
    }

    let tool = tool?;
    if !is_supported_tool(&tool) {
        return None;
    }
    Some(LoopStep {
        phase: phase.unwrap_or_else(|| infer_phase(&tool).to_string()),
        tool,
        input,
        source: DecisionSource::Model,
    })
}

fn fallback_decision(goal: &str, step_index: usize, observations: &[StepObservation]) -> LoopStep {
    let lower_goal = goal.to_ascii_lowercase();
    let last_tool = observations.last().map(|obs| obs.tool.as_str());

    if step_index == 1 {
        return LoopStep {
            phase: String::from("observe"),
            tool: String::from("read-context"),
            input: String::new(),
            source: DecisionSource::Fallback,
        };
    }

    if step_index == 2 {
        if let Some(path) = directive_after(goal, "read ") {
            return loop_step("inspect", "read-file", path);
        }
        if let Some(pattern) = directive_after(goal, "search ") {
            return loop_step("inspect", "search-text", pattern);
        }
        if let Some(path) = directive_after(goal, "tree ") {
            return loop_step("inspect", "file-tree", if path.contains(' ') { path } else { format!("{path} 2") });
        }
        return loop_step("inspect", "file-tree", String::from(". 2"));
    }

    if step_index == 3 {
        return loop_step("plan", "workflow-plan", goal.to_string());
    }

    if lower_goal.contains("write ") && !observations.iter().any(|obs| obs.tool == "write-file") {
        if let Some(spec) = directive_after(goal, "write ") {
            return loop_step("act", "write-file", spec);
        }
    }

    if lower_goal.contains("append ") && !observations.iter().any(|obs| obs.tool == "append-file") {
        if let Some(spec) = directive_after(goal, "append ") {
            return loop_step("act", "append-file", spec);
        }
    }

    if lower_goal.contains("shell ") && !observations.iter().any(|obs| obs.tool == "shell-command") {
        if let Some(command) = directive_after(goal, "shell ") {
            return loop_step("act", "shell-command", command);
        }
    }

    if last_tool != Some("git-status") && !lower_goal.contains("diff") {
        return loop_step("validate", "git-status", String::new());
    }
    if last_tool != Some("git-diff") && lower_goal.contains("diff") {
        return loop_step("validate", "git-diff", String::new());
    }

    loop_step("done", "done", String::from("fallback loop completed"))
}

fn loop_step(phase: &str, tool: &str, input: String) -> LoopStep {
    LoopStep {
        phase: phase.to_string(),
        tool: tool.to_string(),
        input,
        source: DecisionSource::Fallback,
    }
}

fn should_stop_after_step(goal: &str, observations: &[StepObservation]) -> bool {
    if observations.len() < 4 {
        return false;
    }
    let lower_goal = goal.to_ascii_lowercase();
    let last = observations.last();
    match last {
        Some(obs) if obs.tool == "git-status" && obs.ok && !lower_goal.contains("write ") && !lower_goal.contains("append ") && !lower_goal.contains("shell ") => true,
        Some(obs) if obs.tool == "git-diff" && obs.ok && !lower_goal.contains("write ") && !lower_goal.contains("append ") && !lower_goal.contains("shell ") => true,
        _ => false,
    }
}

fn is_supported_tool(tool: &str) -> bool {
    matches!(
        tool,
        "read-context"
            | "file-tree"
            | "read-file"
            | "search-text"
            | "workflow-plan"
            | "git-status"
            | "git-diff"
            | "write-file"
            | "append-file"
            | "shell-command"
            | "done"
    )
}

fn infer_phase(tool: &str) -> &'static str {
    match tool {
        "read-context" => "observe",
        "file-tree" | "read-file" | "search-text" => "inspect",
        "workflow-plan" => "plan",
        "write-file" | "append-file" | "shell-command" => "act",
        "git-status" | "git-diff" => "validate",
        "done" => "done",
        _ => "inspect",
    }
}

fn audit_if_high_permission(
    data_home: &str,
    session_id: &str,
    tool: &str,
    input: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let kind = match tool {
        "shell-command" => Some("cli.agent-loop.shell-command"),
        "write-file" => Some("cli.agent-loop.write-file"),
        "append-file" => Some("cli.agent-loop.append-file"),
        _ => None,
    };
    if let Some(kind) = kind {
        let dir = PathBuf::from(data_home).join("audit");
        fs::create_dir_all(&dir)?;
        let path = dir.join("high-permission.log");
        let line = format!(
            "{}\t{}\tsession={} tool={} input={}\n",
            now_ms(),
            kind,
            session_id,
            tool,
            redact_for_audit(input)
        );
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
        file.write_all(line.as_bytes())?;
    }
    Ok(())
}

fn redact_for_audit(value: &str) -> String {
    let mut text = value.replace('\n', "\\n").replace('\t', " ");
    for marker in ["OCTOCODE_TOKEN=", "OPENAI_API_KEY=", "OCTOCODE_API_TOKEN="] {
        if let Some(index) = text.find(marker) {
            let start = index + marker.len();
            let end = text[start..]
                .find(|ch: char| ch.is_whitespace() || ch == '&')
                .map(|offset| start + offset)
                .unwrap_or_else(|| text.len());
            text.replace_range(start..end, "<redacted>");
        }
    }
    if text.len() > 500 {
        text.truncate(500);
        text.push_str("...[truncated]");
    }
    text
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn parse_goal_and_max_steps(goal: &str) -> (String, usize) {
    let mut max_steps = DEFAULT_MAX_STEPS;
    let mut parts = Vec::new();
    let mut iter = goal.split_whitespace().peekable();
    while let Some(part) = iter.next() {
        if part == "--max" || part == "--steps" {
            if let Some(value) = iter.next() {
                max_steps = value.parse::<usize>().unwrap_or(DEFAULT_MAX_STEPS).max(1).min(HARD_MAX_STEPS);
            }
        } else if let Some(value) = part.strip_prefix("--max=").or_else(|| part.strip_prefix("--steps=")) {
            max_steps = value.parse::<usize>().unwrap_or(DEFAULT_MAX_STEPS).max(1).min(HARD_MAX_STEPS);
        } else {
            parts.push(part);
        }
    }
    let normalized = normalize_goal(&parts.join(" "));
    (normalized, max_steps)
}

fn directive_after(goal: &str, marker: &str) -> Option<String> {
    let lower = goal.to_ascii_lowercase();
    let index = lower.find(marker)? + marker.len();
    let value = goal[index..]
        .split([';', '\n'])
        .next()
        .unwrap_or_default()
        .trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_goal(goal: &str) -> String {
    let trimmed = goal.trim();
    if trimmed.is_empty() {
        String::from("continue current task")
    } else {
        trimmed.to_string()
    }
}

fn clip_output(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut clipped = value.chars().take(max_chars).collect::<String>();
    clipped.push_str("...[truncated]");
    clipped
}

#[cfg(test)]
mod tests {
    use super::{fallback_decision, parse_goal_and_max_steps, parse_model_decision, DecisionSource};

    #[test]
    fn parses_model_decision_lines() {
        let step = parse_model_decision("tool=search-text\ninput=RuntimeProviderRouter\nphase=inspect")
            .expect("decision parses");
        assert_eq!(step.tool, "search-text");
        assert_eq!(step.input, "RuntimeProviderRouter");
        assert_eq!(step.source, DecisionSource::Model);
    }

    #[test]
    fn rejects_unsupported_model_tool() {
        assert!(parse_model_decision("tool=delete-world\ninput=x\nphase=act").is_none());
    }

    #[test]
    fn parses_max_steps_flag() {
        let (goal, max) = parse_goal_and_max_steps("ship feature --max 12");
        assert_eq!(goal, "ship feature");
        assert_eq!(max, 12);
    }

    #[test]
    fn fallback_starts_with_context() {
        let step = fallback_decision("ship feature", 1, &[]);
        assert_eq!(step.tool, "read-context");
    }
}
