use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use octocode_core::{ConversationRole, PermissionMode, PromptRequest, ToolCall};

use crate::server::AppRuntime;

const DEFAULT_MAX_STEPS: usize = 8;
const HARD_MAX_STEPS: usize = 25;
const MEMORY_FILE_NAME: &str = "agent-memory.jsonl";
const TASK_TREE_FILE_NAME: &str = "agent-task-trees.jsonl";

#[derive(Debug, Clone)]
struct LoopStep {
    phase: String,
    tool: String,
    input: String,
    source: DecisionSource,
    agent: AgentRole,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DecisionSource {
    Model,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentRole {
    Planner,
    Executor,
    Validator,
}

impl AgentRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Planner => "planner",
            Self::Executor => "executor",
            Self::Validator => "validator",
        }
    }
}

#[derive(Debug, Clone)]
struct StepObservation {
    step_index: usize,
    agent: AgentRole,
    tool: String,
    input: String,
    ok: bool,
    output: String,
    reflection: Option<String>,
}

#[derive(Debug, Clone)]
struct TaskNode {
    id: String,
    title: String,
    status: String,
}

pub fn run_agent_loop_cli(
    runtime: &mut AppRuntime,
    session_id: &str,
    goal: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let (goal, max_steps) = parse_goal_and_max_steps(goal);
    let data_home = runtime.config_paths().data_home;
    let memory = load_recent_memory(&data_home, 8).unwrap_or_default();
    let mut task_tree = build_task_tree(&goal);
    persist_task_tree(&data_home, session_id, &goal, &task_tree)?;

    runtime.append_session_message(
        session_id,
        ConversationRole::System,
        format!(
            "agent-loop auto start: goal={} maxSteps={} mode=multi-agent-reflective-model-decide memoryItems={} tasks={}",
            goal,
            max_steps,
            memory.len(),
            task_tree.len()
        ),
    )?;

    if !memory.is_empty() {
        runtime.append_session_message(
            session_id,
            ConversationRole::System,
            format!("agent-memory loaded:\n{}", memory.join("\n")),
        )?;
    }

    println!("agent-loop start session={} maxSteps={} goal={}", session_id, max_steps, goal);

    let mut observations: Vec<StepObservation> = Vec::new();
    let mut lines = vec![
        format!("agent-loop auto executed for: {goal}"),
        format!("maxSteps={max_steps}"),
        String::from("agents=planner,executor,validator"),
        format!("memory.items={}", memory.len()),
        format!("taskTree.nodes={}", task_tree.len()),
    ];
    let mut stopped_reason = String::from("max steps reached");

    for step_index in 1..=max_steps {
        let agent = select_agent_role(step_index, &observations);
        let decision = decide_next_step(runtime, session_id, &goal, step_index, &observations, &memory, &task_tree, agent.clone());
        if decision.tool == "done" {
            stopped_reason = if decision.input.trim().is_empty() {
                format!("{} decided done", decision.agent.as_str())
            } else {
                format!("done: {}", decision.input)
            };
            println!("agent-loop step={} done agent={} reason={}", step_index, decision.agent.as_str(), stopped_reason);
            runtime.append_session_message(
                session_id,
                ConversationRole::Assistant,
                format!("agent-loop done: {stopped_reason}"),
            )?;
            mark_task_completed(&mut task_tree, "validate");
            break;
        }

        update_task_tree_for_phase(&mut task_tree, &decision.phase, "running");
        persist_task_tree(&data_home, session_id, &goal, &task_tree)?;

        println!(
            "agent-loop step={} agent={} phase={} tool={} source={:?}",
            step_index, decision.agent.as_str(), decision.phase, decision.tool, decision.source
        );
        runtime.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!(
                "agent-loop step={} agent={} phase={} tool={} source={:?} input={}",
                step_index,
                decision.agent.as_str(),
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
                    "agent-loop step={} agent={} ok outputChars={}",
                    step_index,
                    decision.agent.as_str(),
                    result.output.chars().count()
                );
                update_task_tree_for_phase(&mut task_tree, &decision.phase, "done");
                persist_task_tree(&data_home, session_id, &goal, &task_tree)?;
                runtime.append_session_message(
                    session_id,
                    ConversationRole::Tool,
                    format!("agent-loop observation step={} agent={} => {}", step_index, decision.agent.as_str(), output),
                )?;
                let mut observation = StepObservation {
                    step_index,
                    agent: decision.agent.clone(),
                    tool: decision.tool.clone(),
                    input: decision.input.clone(),
                    ok: true,
                    output,
                    reflection: None,
                };
                let reflection = reflect_on_step(runtime, session_id, &goal, &observation, &observations, &task_tree, &memory);
                if !reflection.trim().is_empty() {
                    println!("agent-loop step={} reflection={}", step_index, clip_output(&reflection, 180));
                    runtime.append_session_message(
                        session_id,
                        ConversationRole::Tool,
                        format!("agent-loop reflection step={} => {}", step_index, reflection),
                    )?;
                    observation.reflection = Some(reflection);
                }
                append_memory(&data_home, session_id, &goal, &observation)?;
                observations.push(observation);
                lines.push(format!(
                    "step.{} agent={} {} {} ok source={:?}",
                    step_index,
                    decision.agent.as_str(),
                    decision.phase,
                    decision.tool,
                    decision.source
                ));
            }
            Err(error) => {
                stopped_reason = format!("step {step_index} failed on {}: {error}", decision.tool);
                println!("agent-loop step={} agent={} failed error={}", step_index, decision.agent.as_str(), error);
                update_task_tree_for_phase(&mut task_tree, &decision.phase, "failed");
                persist_task_tree(&data_home, session_id, &goal, &task_tree)?;
                runtime.append_session_message(
                    session_id,
                    ConversationRole::System,
                    stopped_reason.clone(),
                )?;
                observations.push(StepObservation {
                    step_index,
                    agent: decision.agent.clone(),
                    tool: decision.tool.clone(),
                    input: decision.input.clone(),
                    ok: false,
                    output: error.to_string(),
                    reflection: Some(String::from("tool failed; next step should recover or stop")),
                });
                lines.push(format!(
                    "step.{} agent={} {} {} failed source={:?} error={}",
                    step_index,
                    decision.agent.as_str(),
                    decision.phase,
                    decision.tool,
                    decision.source,
                    error
                ));
                break;
            }
        }

        if should_stop_after_step(&goal, &observations) {
            stopped_reason = String::from("validator accepted current state");
            println!("agent-loop stop reason={}", stopped_reason);
            break;
        }
    }

    lines.push(format!("stopped={stopped_reason}"));
    lines.push(format!("taskTree.final={}", render_task_tree(&task_tree)));
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
    memory: &[String],
    task_tree: &[TaskNode],
    agent: AgentRole,
) -> LoopStep {
    let prompt = build_decision_prompt(session_id, goal, step_index, observations, memory, task_tree, &agent);
    match runtime.prompt(PromptRequest {
        text: prompt,
        model: runtime.config().default_model.clone(),
    }) {
        Ok(response) => parse_model_decision(&response.output, agent.clone())
            .unwrap_or_else(|| fallback_decision(goal, step_index, observations, agent)),
        Err(_) => fallback_decision(goal, step_index, observations, agent),
    }
}

fn build_decision_prompt(
    session_id: &str,
    goal: &str,
    step_index: usize,
    observations: &[StepObservation],
    memory: &[String],
    task_tree: &[TaskNode],
    agent: &AgentRole,
) -> String {
    let history = observations
        .iter()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|obs| {
            format!(
                "step={} agent={} tool={} ok={} input={} output={} reflection={} ",
                obs.step_index,
                obs.agent.as_str(),
                obs.tool,
                obs.ok,
                obs.input,
                clip_output(&obs.output, 420),
                obs.reflection.as_deref().unwrap_or("<none>")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let memory_block = if memory.is_empty() { String::from("<none>") } else { memory.join("\n") };
    let task_tree_block = render_task_tree(task_tree);

    format!(
        concat!(
            "You are Octocode's {} agent in a local multi-agent execution loop.\n",
            "Choose exactly one next tool call for this bounded loop.\n",
            "Return only lines in this exact format:\n",
            "tool=<one of read-context,file-tree,read-file,search-text,workflow-plan,git-status,git-diff,write-file,append-file,shell-command,done>\n",
            "input=<tool input, or reason if done>\n",
            "phase=<observe|inspect|plan|act|validate|done>\n\n",
            "Role guidance:\n",
            "- planner: clarify task, inspect context, or produce workflow-plan.\n",
            "- executor: perform one concrete tool action, including mutation only when explicitly required.\n",
            "- validator: verify with git-status/git-diff/read/search or choose done if satisfied.\n\n",
            "Rules:\n",
            "- Prefer read-context/file-tree/search-text/read-file before writing.\n",
            "- Use write-file/append-file/shell-command only if the goal explicitly requires mutation or command execution.\n",
            "- If validation is sufficient, choose tool=done.\n",
            "- Do not invent unsupported tools.\n\n",
            "session={}\n",
            "goal={}\n",
            "stepIndex={}\n",
            "taskTree={}\n",
            "longTermMemory:\n{}\n",
            "recentObservationsAndReflections:\n{}\n"
        ),
        agent.as_str(),
        session_id,
        goal,
        step_index,
        task_tree_block,
        memory_block,
        if history.is_empty() { "<none>" } else { &history }
    )
}

fn reflect_on_step(
    runtime: &mut AppRuntime,
    session_id: &str,
    goal: &str,
    observation: &StepObservation,
    previous: &[StepObservation],
    task_tree: &[TaskNode],
    memory: &[String],
) -> String {
    let prompt = format!(
        concat!(
            "You are Octocode's validator agent. Reflect on the latest loop step.\n",
            "Return one short line with: keep|adjust|stop - reason.\n",
            "Do not request unsupported tools.\n\n",
            "session={}\n",
            "goal={}\n",
            "taskTree={}\n",
            "memory={}\n",
            "latestStep={} agent={} tool={} ok={} input={} output={}\n",
            "previousSteps={}\n"
        ),
        session_id,
        goal,
        render_task_tree(task_tree),
        if memory.is_empty() { String::from("<none>") } else { memory.join(" | ") },
        observation.step_index,
        observation.agent.as_str(),
        observation.tool,
        observation.ok,
        observation.input,
        clip_output(&observation.output, 600),
        previous.len()
    );
    runtime
        .prompt(PromptRequest {
            text: prompt,
            model: runtime.config().default_model.clone(),
        })
        .map(|response| clip_output(response.output.trim(), 500))
        .unwrap_or_else(|_| fallback_reflection(observation))
}

fn fallback_reflection(observation: &StepObservation) -> String {
    if !observation.ok {
        return String::from("adjust - last tool failed; recover or stop");
    }
    match observation.tool.as_str() {
        "git-status" | "git-diff" => String::from("stop - validation signal collected"),
        "workflow-plan" => String::from("keep - plan available; continue to execution or validation"),
        "write-file" | "append-file" | "shell-command" => String::from("adjust - mutation executed; validate next"),
        _ => String::from("keep - context gathered; continue"),
    }
}

fn parse_model_decision(output: &str, agent: AgentRole) -> Option<LoopStep> {
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
        agent,
    })
}

fn fallback_decision(goal: &str, step_index: usize, observations: &[StepObservation], agent: AgentRole) -> LoopStep {
    let lower_goal = goal.to_ascii_lowercase();
    let last_tool = observations.last().map(|obs| obs.tool.as_str());
    let last_reflection = observations.last().and_then(|obs| obs.reflection.as_deref()).unwrap_or("");

    if last_reflection.starts_with("stop") && step_index > 3 {
        return loop_step("done", "done", String::from("reflection requested stop"), agent);
    }

    if step_index == 1 {
        return LoopStep {
            phase: String::from("observe"),
            tool: String::from("read-context"),
            input: String::new(),
            source: DecisionSource::Fallback,
            agent,
        };
    }

    if step_index == 2 {
        if let Some(path) = directive_after(goal, "read ") {
            return loop_step("inspect", "read-file", path, agent);
        }
        if let Some(pattern) = directive_after(goal, "search ") {
            return loop_step("inspect", "search-text", pattern, agent);
        }
        if let Some(path) = directive_after(goal, "tree ") {
            return loop_step("inspect", "file-tree", if path.contains(' ') { path } else { format!("{path} 2") }, agent);
        }
        return loop_step("inspect", "file-tree", String::from(". 2"), agent);
    }

    if step_index == 3 {
        return loop_step("plan", "workflow-plan", goal.to_string(), agent);
    }

    if lower_goal.contains("write ") && !observations.iter().any(|obs| obs.tool == "write-file") {
        if let Some(spec) = directive_after(goal, "write ") {
            return loop_step("act", "write-file", spec, agent);
        }
    }

    if lower_goal.contains("append ") && !observations.iter().any(|obs| obs.tool == "append-file") {
        if let Some(spec) = directive_after(goal, "append ") {
            return loop_step("act", "append-file", spec, agent);
        }
    }

    if lower_goal.contains("shell ") && !observations.iter().any(|obs| obs.tool == "shell-command") {
        if let Some(command) = directive_after(goal, "shell ") {
            return loop_step("act", "shell-command", command, agent);
        }
    }

    if last_tool != Some("git-status") && !lower_goal.contains("diff") {
        return loop_step("validate", "git-status", String::new(), agent);
    }
    if last_tool != Some("git-diff") && lower_goal.contains("diff") {
        return loop_step("validate", "git-diff", String::new(), agent);
    }

    loop_step("done", "done", String::from("fallback loop completed"), agent)
}

fn select_agent_role(step_index: usize, observations: &[StepObservation]) -> AgentRole {
    if observations.last().map(|obs| obs.tool.as_str()) == Some("workflow-plan") {
        return AgentRole::Executor;
    }
    if observations.last().map(|obs| matches!(obs.tool.as_str(), "write-file" | "append-file" | "shell-command")).unwrap_or(false) {
        return AgentRole::Validator;
    }
    match step_index % 3 {
        1 => AgentRole::Planner,
        2 => AgentRole::Executor,
        _ => AgentRole::Validator,
    }
}

fn loop_step(phase: &str, tool: &str, input: String, agent: AgentRole) -> LoopStep {
    LoopStep {
        phase: phase.to_string(),
        tool: tool.to_string(),
        input,
        source: DecisionSource::Fallback,
        agent,
    }
}

fn should_stop_after_step(goal: &str, observations: &[StepObservation]) -> bool {
    if observations.len() < 4 {
        return false;
    }
    if observations.last().and_then(|obs| obs.reflection.as_deref()).map(|value| value.starts_with("stop")).unwrap_or(false) {
        return true;
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

fn build_task_tree(goal: &str) -> Vec<TaskNode> {
    let mut nodes = vec![
        TaskNode { id: String::from("observe"), title: String::from("Load project context and memory"), status: String::from("pending") },
        TaskNode { id: String::from("inspect"), title: String::from("Inspect relevant files or tree"), status: String::from("pending") },
        TaskNode { id: String::from("plan"), title: String::from("Produce implementation plan"), status: String::from("pending") },
        TaskNode { id: String::from("validate"), title: String::from("Validate with git status or diff"), status: String::from("pending") },
    ];
    let lower = goal.to_ascii_lowercase();
    if lower.contains("write ") || lower.contains("append ") || lower.contains("shell ") {
        nodes.insert(3, TaskNode { id: String::from("act"), title: String::from("Execute requested mutation or command"), status: String::from("pending") });
    }
    nodes
}

fn update_task_tree_for_phase(nodes: &mut [TaskNode], phase: &str, status: &str) {
    let id = match phase {
        "observe" => "observe",
        "inspect" => "inspect",
        "plan" => "plan",
        "act" => "act",
        "validate" => "validate",
        _ => phase,
    };
    if let Some(node) = nodes.iter_mut().find(|node| node.id == id) {
        node.status = status.to_string();
    }
}

fn mark_task_completed(nodes: &mut [TaskNode], id: &str) {
    if let Some(node) = nodes.iter_mut().find(|node| node.id == id) {
        node.status = String::from("done");
    }
}

fn render_task_tree(nodes: &[TaskNode]) -> String {
    nodes
        .iter()
        .map(|node| format!("{}:{}:{}", node.id, node.status, node.title))
        .collect::<Vec<_>>()
        .join(" | ")
}

fn persist_task_tree(data_home: &str, session_id: &str, goal: &str, nodes: &[TaskNode]) -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(data_home).join("agent");
    fs::create_dir_all(&dir)?;
    let path = dir.join(TASK_TREE_FILE_NAME);
    let body = format!(
        "{{\"atMs\":{},\"session\":\"{}\",\"goal\":\"{}\",\"tree\":\"{}\"}}\n",
        now_ms(),
        escape_json(session_id),
        escape_json(goal),
        escape_json(&render_task_tree(nodes))
    );
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(body.as_bytes())?;
    Ok(())
}

fn load_recent_memory(data_home: &str, max_items: usize) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let path = PathBuf::from(data_home).join("agent").join(MEMORY_FILE_NAME);
    let raw = fs::read_to_string(path).unwrap_or_default();
    Ok(raw
        .lines()
        .rev()
        .take(max_items)
        .map(|line| line.to_string())
        .collect::<Vec<_>>())
}

fn append_memory(data_home: &str, session_id: &str, goal: &str, observation: &StepObservation) -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(data_home).join("agent");
    fs::create_dir_all(&dir)?;
    let path = dir.join(MEMORY_FILE_NAME);
    let line = format!(
        "{{\"atMs\":{},\"session\":\"{}\",\"goal\":\"{}\",\"agent\":\"{}\",\"tool\":\"{}\",\"ok\":{},\"reflection\":\"{}\"}}\n",
        now_ms(),
        escape_json(session_id),
        escape_json(goal),
        observation.agent.as_str(),
        escape_json(&observation.tool),
        observation.ok,
        escape_json(observation.reflection.as_deref().unwrap_or(""))
    );
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    Ok(())
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
    use super::{build_task_tree, fallback_decision, parse_goal_and_max_steps, parse_model_decision, render_task_tree, select_agent_role, AgentRole, DecisionSource};

    #[test]
    fn parses_model_decision_lines() {
        let step = parse_model_decision("tool=search-text\ninput=RuntimeProviderRouter\nphase=inspect", AgentRole::Planner)
            .expect("decision parses");
        assert_eq!(step.tool, "search-text");
        assert_eq!(step.input, "RuntimeProviderRouter");
        assert_eq!(step.source, DecisionSource::Model);
        assert_eq!(step.agent, AgentRole::Planner);
    }

    #[test]
    fn rejects_unsupported_model_tool() {
        assert!(parse_model_decision("tool=delete-world\ninput=x\nphase=act", AgentRole::Executor).is_none());
    }

    #[test]
    fn parses_max_steps_flag() {
        let (goal, max) = parse_goal_and_max_steps("ship feature --max 12");
        assert_eq!(goal, "ship feature");
        assert_eq!(max, 12);
    }

    #[test]
    fn fallback_starts_with_context() {
        let step = fallback_decision("ship feature", 1, &[], AgentRole::Planner);
        assert_eq!(step.tool, "read-context");
    }

    #[test]
    fn agent_roles_rotate() {
        assert_eq!(select_agent_role(1, &[]), AgentRole::Planner);
        assert_eq!(select_agent_role(2, &[]), AgentRole::Executor);
        assert_eq!(select_agent_role(3, &[]), AgentRole::Validator);
    }

    #[test]
    fn task_tree_adds_act_for_mutation_goals() {
        let tree = build_task_tree("write README.md|hello");
        assert!(render_task_tree(&tree).contains("act:pending"));
    }
}
