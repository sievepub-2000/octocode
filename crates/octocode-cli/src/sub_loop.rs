use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use octocode_core::{PermissionMode, ToolCall};

pub const MAX_SUB_LOOPS: usize = 4;
pub const MIN_SUB_LOOP_STEPS: usize = 4;
pub const DEFAULT_SUB_LOOP_STEPS: usize = 6;
pub const HARD_MAX_SUB_LOOP_STEPS: usize = 14;
pub const MAX_SUB_LOOP_OUTPUT_CHARS: usize = 1400;

#[derive(Debug, Clone)]
pub struct SubTask {
    pub id: String,
    pub goal: String,
}

#[derive(Debug, Clone)]
pub struct SubLoopStep {
    pub index: usize,
    pub phase: String,
    pub action: String,
    pub output: String,
}

#[derive(Debug, Clone)]
pub struct SubLoopReport {
    pub id: String,
    pub session_id: String,
    pub goal: String,
    pub steps: Vec<SubLoopStep>,
    pub status: String,
    pub elapsed_ms: u128,
    pub merge_recommendation: String,
}

#[derive(Debug, Clone)]
pub struct WriteQueueItem {
    pub sub_loop_id: String,
    pub session_id: String,
    pub tool: String,
    pub input: String,
    pub reason: String,
}

pub trait SubLoopRuntime: Send + Sync + 'static {
    fn run_readonly_tool(
        &self,
        session_id: &str,
        call: ToolCall,
    ) -> Result<String, String>;
}

pub fn plan_sub_tasks(goal: &str) -> Vec<SubTask> {
    let mut tasks = Vec::new();
    for (i, part) in goal
        .split(|c| c == ';' || c == '\n')
        .flat_map(|s| s.split(" and "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(MAX_SUB_LOOPS)
        .enumerate()
    {
        tasks.push(SubTask {
            id: format!("sub-{}", i + 1),
            goal: part.to_string(),
        });
    }
    if tasks.is_empty() {
        tasks.push(SubTask {
            id: String::from("sub-1"),
            goal: goal.to_string(),
        });
    }
    tasks
}

pub fn run_parallel_execution(tasks: Vec<SubTask>) -> Vec<String> {
    run_independent_sub_loops("demo", tasks)
        .into_iter()
        .map(|report| render_sub_loop_report(&report))
        .collect()
}

pub fn run_parallel_runtime_execution<R: SubLoopRuntime>(
    runtime: Arc<R>,
    parent_session_id: &str,
    tasks: Vec<SubTask>,
) -> (Vec<SubLoopReport>, Vec<WriteQueueItem>) {
    let reports = Arc::new(Mutex::new(Vec::new()));
    let write_queue = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for task in tasks.into_iter().take(MAX_SUB_LOOPS) {
        let reports = Arc::clone(&reports);
        let write_queue = Arc::clone(&write_queue);
        let runtime = Arc::clone(&runtime);
        let parent_session_id = parent_session_id.to_string();
        handles.push(thread::spawn(move || {
            let (report, queued) = run_one_runtime_sub_loop(runtime.as_ref(), &parent_session_id, task);
            if let Ok(mut guard) = reports.lock() {
                guard.push(report);
            }
            if let Ok(mut guard) = write_queue.lock() {
                guard.extend(queued);
            }
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    let mut reports = Arc::try_unwrap(reports)
        .unwrap_or_else(|arc| (*arc).clone())
        .into_inner()
        .unwrap_or_default();
    reports.sort_by(|a, b| a.id.cmp(&b.id));
    let mut queued = Arc::try_unwrap(write_queue)
        .unwrap_or_else(|arc| (*arc).clone())
        .into_inner()
        .unwrap_or_default();
    queued.sort_by(|a, b| a.sub_loop_id.cmp(&b.sub_loop_id));
    (reports, queued)
}

pub fn run_independent_sub_loops(parent_session_id: &str, tasks: Vec<SubTask>) -> Vec<SubLoopReport> {
    let reports = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for task in tasks.into_iter().take(MAX_SUB_LOOPS) {
        let reports = Arc::clone(&reports);
        let parent_session_id = parent_session_id.to_string();
        handles.push(thread::spawn(move || {
            let report = run_one_sub_loop(&parent_session_id, task);
            if let Ok(mut guard) = reports.lock() {
                guard.push(report);
            }
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    let mut reports = Arc::try_unwrap(reports)
        .unwrap_or_else(|arc| (*arc).clone())
        .into_inner()
        .unwrap_or_default();
    reports.sort_by(|a, b| a.id.cmp(&b.id));
    reports
}

fn run_one_runtime_sub_loop<R: SubLoopRuntime>(
    runtime: &R,
    parent_session_id: &str,
    task: SubTask,
) -> (SubLoopReport, Vec<WriteQueueItem>) {
    let started = Instant::now();
    let session_id = format!("{}-{}", sanitize_id(parent_session_id), sanitize_id(&task.id));
    let mut steps = Vec::new();
    let mut queued = Vec::new();
    let step_budget = budget_for_goal(&task.goal);

    for index in 1..=step_budget {
        let phase = choose_phase(index, &task.goal, &steps, step_budget);
        let action = choose_action(&phase, &task.goal, &steps);
        if let Some((tool, input)) = parse_runtime_action(&action) {
            if is_mutating_tool(tool) {
                queued.push(WriteQueueItem {
                    sub_loop_id: task.id.clone(),
                    session_id: session_id.clone(),
                    tool: tool.to_string(),
                    input: input.to_string(),
                    reason: format!("{} requires serialized parent merge", phase),
                });
                steps.push(SubLoopStep {
                    index,
                    phase,
                    action,
                    output: String::from("QUEUED_FOR_PARENT_WRITE_COMMIT"),
                });
            } else {
                let output = runtime
                    .run_readonly_tool(
                        &session_id,
                        ToolCall {
                            name: tool.to_string(),
                            input: input.to_string(),
                            permission: PermissionMode::ReadOnly,
                        },
                    )
                    .unwrap_or_else(|error| format!("sub-loop runtime error: {error}"));
                steps.push(SubLoopStep {
                    index,
                    phase,
                    action,
                    output: clip(&output, MAX_SUB_LOOP_OUTPUT_CHARS),
                });
            }
        } else {
            let output = execute_virtual_sub_action(&phase, &action, &task.goal, &steps);
            steps.push(SubLoopStep {
                index,
                phase: phase.clone(),
                action,
                output: clip(&output, MAX_SUB_LOOP_OUTPUT_CHARS),
            });
        }

        if phase == "done" || steps.last().map(|s| s.output.contains("SUB_LOOP_DONE")).unwrap_or(false) {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }

    let mut merge_recommendation = build_merge_recommendation(&task, &steps, step_budget);
    if !queued.is_empty() {
        merge_recommendation.push_str(&format!(" | queuedWrites={}", queued.len()));
    }
    let report = SubLoopReport {
        id: task.id,
        session_id,
        goal: task.goal,
        steps,
        status: String::from("completed"),
        elapsed_ms: started.elapsed().as_millis(),
        merge_recommendation,
    };
    (report, queued)
}

fn run_one_sub_loop(parent_session_id: &str, task: SubTask) -> SubLoopReport {
    let started = Instant::now();
    let session_id = format!("{}-{}", sanitize_id(parent_session_id), sanitize_id(&task.id));
    let mut steps = Vec::new();
    let step_budget = budget_for_goal(&task.goal);

    for index in 1..=step_budget {
        let phase = choose_phase(index, &task.goal, &steps, step_budget);
        let action = choose_action(&phase, &task.goal, &steps);
        let output = execute_virtual_sub_action(&phase, &action, &task.goal, &steps);
        let done = phase == "done" || output.contains("SUB_LOOP_DONE");
        steps.push(SubLoopStep {
            index,
            phase,
            action,
            output: clip(&output, MAX_SUB_LOOP_OUTPUT_CHARS),
        });
        if done {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }

    let merge_recommendation = build_merge_recommendation(&task, &steps, step_budget);
    SubLoopReport {
        id: task.id,
        session_id,
        goal: task.goal,
        steps,
        status: String::from("completed"),
        elapsed_ms: started.elapsed().as_millis(),
        merge_recommendation,
    }
}

pub fn budget_for_goal(goal: &str) -> usize {
    let lower = goal.to_ascii_lowercase();
    let mut budget = DEFAULT_SUB_LOOP_STEPS;
    if lower.contains("write ") || lower.contains("append ") || lower.contains("shell ") {
        budget += 3;
    }
    if lower.contains("test") || lower.contains("validate") || lower.contains("diff") {
        budget += 2;
    }
    if lower.contains("refactor") || lower.contains("implement") || lower.contains("bug") || lower.contains("fix") {
        budget += 2;
    }
    if goal.len() > 240 {
        budget += 2;
    }
    budget.clamp(MIN_SUB_LOOP_STEPS, HARD_MAX_SUB_LOOP_STEPS)
}

fn choose_phase(index: usize, goal: &str, steps: &[SubLoopStep], step_budget: usize) -> String {
    if steps.last().map(|step| step.phase.as_str()) == Some("validate") && index >= 5 {
        return String::from("done");
    }
    let lower = goal.to_ascii_lowercase();
    let mutation = lower.contains("write ") || lower.contains("append ") || lower.contains("shell ");
    match index {
        1 => String::from("observe"),
        2 => String::from("inspect"),
        3 if mutation => String::from("plan-mutation"),
        3 => String::from("plan"),
        4 if step_budget > 7 => String::from("inspect-deeper"),
        5 if mutation => String::from("validate-mutation-plan"),
        5 => String::from("validate"),
        i if i + 1 < step_budget && i % 2 == 0 => String::from("inspect-deeper"),
        i if i + 1 < step_budget => String::from("plan"),
        i if i < step_budget => String::from("validate"),
        _ => String::from("done"),
    }
}

fn choose_action(phase: &str, goal: &str, _steps: &[SubLoopStep]) -> String {
    match phase {
        "observe" => String::from("read-context"),
        "inspect" | "inspect-deeper" if goal.to_ascii_lowercase().contains("search ") => format!("search-text {}", directive_after(goal, "search ").unwrap_or_else(|| goal.to_string())),
        "inspect" | "inspect-deeper" if goal.to_ascii_lowercase().contains("read ") => format!("read-file {}", directive_after(goal, "read ").unwrap_or_else(|| String::from("README.md"))),
        "inspect" => String::from("file-tree . 2"),
        "inspect-deeper" => String::from("file-tree . 3"),
        "plan-mutation" if goal.to_ascii_lowercase().contains("write ") => format!("write-file {}", directive_after(goal, "write ").unwrap_or_else(|| goal.to_string())),
        "plan-mutation" if goal.to_ascii_lowercase().contains("append ") => format!("append-file {}", directive_after(goal, "append ").unwrap_or_else(|| goal.to_string())),
        "plan-mutation" if goal.to_ascii_lowercase().contains("shell ") => format!("shell-command {}", directive_after(goal, "shell ").unwrap_or_else(|| goal.to_string())),
        "plan-mutation" => String::from("workflow-plan"),
        "plan" => String::from("workflow-plan"),
        "validate" | "validate-mutation-plan" => String::from("git-status"),
        "done" => String::from("done"),
        _ => String::from("noop"),
    }
}

fn parse_runtime_action(action: &str) -> Option<(&str, &str)> {
    let mut parts = action.splitn(2, ' ');
    let tool = parts.next()?.trim();
    let input = parts.next().unwrap_or("").trim();
    if tool == "done" || tool == "noop" {
        None
    } else {
        Some((tool, input))
    }
}

fn is_mutating_tool(tool: &str) -> bool {
    matches!(tool, "write-file" | "append-file" | "shell-command")
}

fn execute_virtual_sub_action(
    phase: &str,
    action: &str,
    goal: &str,
    steps: &[SubLoopStep],
) -> String {
    match phase {
        "observe" => format!("observed goal context: {}", clip(goal, 360)),
        "inspect" | "inspect-deeper" => format!("inspection action selected: {action}"),
        "plan-mutation" => format!("mutation is deferred to parent serialized merge queue: {}", clip(goal, 360)),
        "validate-mutation-plan" => format!("validator checked serialized mutation plan after {} prior steps", steps.len()),
        "plan" => format!("sub-plan: execute smallest safe slice for '{}'; validate after merge", clip(goal, 240)),
        "validate" => format!("validator reviewed {} prior steps; parent should run git-status/git-diff", steps.len()),
        "done" => String::from("SUB_LOOP_DONE"),
        _ => String::from("noop"),
    }
}

fn build_merge_recommendation(task: &SubTask, steps: &[SubLoopStep], step_budget: usize) -> String {
    let mutation = task.goal.to_ascii_lowercase().contains("write ")
        || task.goal.to_ascii_lowercase().contains("append ")
        || task.goal.to_ascii_lowercase().contains("shell ");
    let evidence = steps
        .iter()
        .map(|step| format!("{}:{}", step.index, step.phase))
        .collect::<Vec<_>>()
        .join(",");
    if mutation {
        format!(
            "queue-for-parent-merge: {} | reason=mutation must be serialized | budget={} | evidence={}",
            clip(&task.goal, 360),
            step_budget,
            evidence
        )
    } else {
        format!(
            "safe-readonly-result: {} | budget={} | evidence={}",
            clip(&task.goal, 360),
            step_budget,
            evidence
        )
    }
}

pub fn render_sub_loop_report(report: &SubLoopReport) -> String {
    let steps = report
        .steps
        .iter()
        .map(|step| format!("{}:{}:{}", step.index, step.phase, step.action))
        .collect::<Vec<_>>()
        .join(" | ");
    format!(
        "[sub-loop:{} session={} status={} elapsedMs={}] goal={} steps=[{}] merge={}",
        report.id,
        report.session_id,
        report.status,
        report.elapsed_ms,
        clip(&report.goal, 300),
        steps,
        report.merge_recommendation
    )
}

pub fn render_write_queue(queue: &[WriteQueueItem]) -> String {
    queue
        .iter()
        .map(|item| {
            format!(
                "[queued-write subLoop={} session={} tool={} input={} reason={}]",
                item.sub_loop_id,
                item.session_id,
                item.tool,
                clip(&item.input, 260),
                item.reason
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
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

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn clip(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = value.chars().take(max_chars).collect::<String>();
    out.push_str("...[truncated]");
    out
}

#[cfg(test)]
mod tests {
    use super::{budget_for_goal, plan_sub_tasks, run_independent_sub_loops, run_parallel_execution, HARD_MAX_SUB_LOOP_STEPS, MAX_SUB_LOOPS};

    #[test]
    fn parallel_exec_runs() {
        let tasks = plan_sub_tasks("a; b; c");
        let out = run_parallel_execution(tasks);
        assert!(out.len() >= 3);
    }

    #[test]
    fn independent_sub_loops_are_bounded() {
        let tasks = plan_sub_tasks("a; b; c; d; e; f");
        let reports = run_independent_sub_loops("demo", tasks);
        assert!(reports.len() <= MAX_SUB_LOOPS);
        assert!(reports.iter().all(|r| !r.steps.is_empty()));
    }

    #[test]
    fn mutation_sub_loop_recommends_serialized_merge() {
        let tasks = plan_sub_tasks("write README.md|hello");
        let reports = run_independent_sub_loops("demo", tasks);
        assert!(reports[0].merge_recommendation.contains("queue-for-parent-merge"));
    }

    #[test]
    fn complex_goals_get_more_steps_but_remain_bounded() {
        let simple = budget_for_goal("read README.md");
        let complex = budget_for_goal("implement bug fix write src/lib.rs|patch and validate diff with tests");
        assert!(complex > simple);
        assert!(complex <= HARD_MAX_SUB_LOOP_STEPS);
    }
}
