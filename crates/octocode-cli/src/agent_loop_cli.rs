use octocode_core::{ConversationRole, PermissionMode, ToolCall};

use crate::server::AppRuntime;

#[derive(Debug, Clone)]
struct LoopStep {
    phase: &'static str,
    tool: &'static str,
    input: String,
}

pub fn run_agent_loop_cli(
    runtime: &mut AppRuntime,
    session_id: &str,
    goal: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let goal = normalize_goal(goal);
    runtime.append_session_message(
        session_id,
        ConversationRole::System,
        format!("agent-loop execute start: {goal}"),
    )?;

    let steps = build_adaptive_steps(&goal);
    let mut lines = vec![
        format!("agent-loop executed for: {goal}"),
        format!("steps.count={}", steps.len()),
    ];

    for step in steps {
        runtime.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!(
                "agent-loop phase={} tool={} input={}",
                step.phase,
                step.tool,
                if step.input.is_empty() { "<empty>" } else { &step.input }
            ),
        )?;

        let result = runtime.run_tool_in_session(
            session_id,
            ToolCall {
                name: String::from(step.tool),
                input: step.input.clone(),
                permission: PermissionMode::ReadOnly,
            },
        );

        match result {
            Ok(result) => {
                let output = clip_output(&result.output, 1200);
                runtime.append_session_message(
                    session_id,
                    ConversationRole::Tool,
                    format!("agent-loop result {} => {}", step.phase, output),
                )?;
                lines.push(format!(
                    "{}: {} ok input={}",
                    step.phase,
                    step.tool,
                    if step.input.is_empty() { "<empty>" } else { &step.input }
                ));
            }
            Err(error) => {
                runtime.append_session_message(
                    session_id,
                    ConversationRole::System,
                    format!("agent-loop stopped on {}: {error}", step.phase),
                )?;
                lines.push(format!("{}: {} failed error={error}", step.phase, step.tool));
                break;
            }
        }
    }

    let summary = lines.join("\n");
    runtime.append_session_message(
        session_id,
        ConversationRole::Assistant,
        summary.clone(),
    )?;
    Ok(summary)
}

fn build_adaptive_steps(goal: &str) -> Vec<LoopStep> {
    let mut steps = vec![LoopStep {
        phase: "observe",
        tool: "read-context",
        input: String::new(),
    }];

    if let Some(path) = directive_after(goal, "read ") {
        steps.push(LoopStep {
            phase: "inspect-read",
            tool: "read-file",
            input: path,
        });
    } else if let Some(pattern) = directive_after(goal, "search ") {
        steps.push(LoopStep {
            phase: "inspect-search",
            tool: "search-text",
            input: pattern,
        });
    } else if let Some(path) = directive_after(goal, "tree ") {
        steps.push(LoopStep {
            phase: "inspect-tree",
            tool: "file-tree",
            input: if path.contains(' ') { path } else { format!("{path} 2") },
        });
    } else {
        steps.push(LoopStep {
            phase: "inspect-tree",
            tool: "file-tree",
            input: String::from(". 2"),
        });
    }

    steps.push(LoopStep {
        phase: "plan",
        tool: "workflow-plan",
        input: String::from(goal),
    });

    if goal.to_ascii_lowercase().contains("diff") {
        steps.push(LoopStep {
            phase: "validate-diff",
            tool: "git-diff",
            input: String::new(),
        });
    } else {
        steps.push(LoopStep {
            phase: "validate-status",
            tool: "git-status",
            input: String::new(),
        });
    }

    steps
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
    use super::build_adaptive_steps;

    #[test]
    fn defaults_to_context_tree_plan_status() {
        let steps = build_adaptive_steps("ship feature");
        assert_eq!(steps.len(), 4);
        assert_eq!(steps[0].tool, "read-context");
        assert_eq!(steps[1].tool, "file-tree");
        assert_eq!(steps[3].tool, "git-status");
    }

    #[test]
    fn search_directive_switches_inspection_tool() {
        let steps = build_adaptive_steps("search RuntimeProviderRouter; then validate diff");
        assert_eq!(steps[1].tool, "search-text");
        assert_eq!(steps[3].tool, "git-diff");
    }
}
