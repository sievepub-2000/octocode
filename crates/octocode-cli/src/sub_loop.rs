use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_SUB_LOOPS: usize = 4;
pub const MAX_SUB_LOOP_STEPS: usize = 6;
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

/// Devin-like sub-loop execution model.
///
/// Each sub-task receives an independent sub-session id and a bounded local loop.
/// The loop is intentionally read/planning oriented. It can recommend writes or
/// shell commands, but actual workspace mutation must be merged by the parent
/// loop's serialized execution path. This gives parallel autonomous reasoning
/// without concurrent destructive writes.
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

fn run_one_sub_loop(parent_session_id: &str, task: SubTask) -> SubLoopReport {
    let started = Instant::now();
    let session_id = format!("{}-{}", sanitize_id(parent_session_id), sanitize_id(&task.id));
    let mut steps = Vec::new();

    for index in 1..=MAX_SUB_LOOP_STEPS {
        let phase = choose_phase(index, &task.goal, &steps);
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

    let merge_recommendation = build_merge_recommendation(&task, &steps);
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

fn choose_phase(index: usize, goal: &str, steps: &[SubLoopStep]) -> String {
    if steps.last().map(|step| step.phase.as_str()) == Some("validate") {
        return String::from("done");
    }
    match index {
        1 => String::from("observe"),
        2 => String::from("inspect"),
        3 if goal.to_ascii_lowercase().contains("write ") || goal.to_ascii_lowercase().contains("append ") || goal.to_ascii_lowercase().contains("shell ") => String::from("plan-mutation"),
        3 => String::from("plan"),
        4 => String::from("validate"),
        _ => String::from("done"),
    }
}

fn choose_action(phase: &str, goal: &str, _steps: &[SubLoopStep]) -> String {
    match phase {
        "observe" => String::from("read file-memory and continuation summary"),
        "inspect" if goal.to_ascii_lowercase().contains("search ") => format!("search-text {}", directive_after(goal, "search ").unwrap_or_else(|| goal.to_string())),
        "inspect" if goal.to_ascii_lowercase().contains("read ") => format!("read-file {}", directive_after(goal, "read ").unwrap_or_else(|| String::from("README.md"))),
        "inspect" => String::from("file-tree . 2"),
        "plan-mutation" => String::from("prepare serialized write/shell recommendation for parent merge queue"),
        "plan" => String::from("workflow-plan"),
        "validate" => String::from("git-status or git-diff after parent merge"),
        "done" => String::from("done"),
        _ => String::from("noop"),
    }
}

fn execute_virtual_sub_action(
    phase: &str,
    action: &str,
    goal: &str,
    steps: &[SubLoopStep],
) -> String {
    match phase {
        "observe" => format!("observed goal context: {}", clip(goal, 360)),
        "inspect" => format!("inspection action selected: {action}"),
        "plan-mutation" => format!("mutation is deferred to parent serialized merge queue: {}", clip(goal, 360)),
        "plan" => format!("sub-plan: execute smallest safe slice for '{}'; validate after merge", clip(goal, 240)),
        "validate" => format!("validator reviewed {} prior steps; parent should run git-status/git-diff", steps.len()),
        "done" => String::from("SUB_LOOP_DONE"),
        _ => String::from("noop"),
    }
}

fn build_merge_recommendation(task: &SubTask, steps: &[SubLoopStep]) -> String {
    let mutation = task.goal.to_ascii_lowercase().contains("write ")
        || task.goal.to_ascii_lowercase().contains("append ")
        || task.goal.to_ascii_lowercase().contains("shell ");
    if mutation {
        format!(
            "queue-for-parent-merge: {} | reason=mutation must be serialized | evidence={}",
            clip(&task.goal, 360),
            steps
                .iter()
                .map(|step| format!("{}:{}", step.index, step.phase))
                .collect::<Vec<_>>()
                .join(",")
        )
    } else {
        format!(
            "safe-readonly-result: {} | evidence={}",
            clip(&task.goal, 360),
            steps
                .iter()
                .map(|step| format!("{}:{}", step.index, step.phase))
                .collect::<Vec<_>>()
                .join(",")
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
    use super::{plan_sub_tasks, run_independent_sub_loops, run_parallel_execution, MAX_SUB_LOOPS};

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
}
