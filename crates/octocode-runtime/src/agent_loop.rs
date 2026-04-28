use octocode_core::{ConversationRole, OctoError, PermissionMode, ToolCall, ToolResult};

/// A single bounded agent loop step.
///
/// The loop intentionally keeps execution deterministic: plan the fixed contract,
/// run one tool per phase, append observations to the session, then stop.
/// Higher-risk tools remain available through the existing permission model and
/// high-permission audit surface; this module does not remove or sandbox
/// danger-full-access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLoopStep {
    pub phase: &'static str,
    pub tool: &'static str,
    pub input: String,
    pub required_permission: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLoopReport {
    pub goal: String,
    pub steps: Vec<AgentLoopStepReport>,
    pub stopped_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLoopStepReport {
    pub phase: String,
    pub tool: String,
    pub input: String,
    pub ok: bool,
    pub output: String,
}

pub trait AgentLoopSessionRuntime {
    fn append_agent_loop_message(
        &self,
        session_id: &str,
        role: ConversationRole,
        content: String,
    ) -> Result<(), OctoError>;

    fn run_agent_loop_tool(
        &self,
        session_id: &str,
        call: ToolCall,
    ) -> Result<ToolResult, OctoError>;

    /// Optional hook fired once per agent-loop run. The default
    /// implementation is a no-op so existing implementors compile
    /// unchanged. The runtime calls this with `success=true` only when
    /// every step in the loop returned `Ok`; otherwise it is invoked
    /// with `success=false` so the skill ledger reflects the failure.
    fn record_skill_outcome(
        &self,
        _session_id: &str,
        _slug: &str,
        _success: bool,
    ) -> Result<(), OctoError> {
        Ok(())
    }
}

/// Pull a `[skill:<slug>]` prefix out of a goal string. The slug must
/// be plain `[a-zA-Z0-9_-]+`. Returns the slug and the remaining goal
/// text. When no prefix is present, the goal is returned unchanged.
pub fn parse_skill_attribution(goal: &str) -> (Option<String>, String) {
    let trimmed = goal.trim_start();
    let Some(rest) = trimmed.strip_prefix("[skill:") else {
        return (None, goal.to_string());
    };
    let Some(end) = rest.find(']') else {
        return (None, goal.to_string());
    };
    let slug = rest[..end].trim();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return (None, goal.to_string());
    }
    let remaining = rest[end + 1..].trim().to_string();
    (Some(slug.to_string()), remaining)
}

pub fn build_bounded_agent_loop(goal: &str) -> Vec<AgentLoopStep> {
    let goal = normalize_goal(goal);
    vec![
        AgentLoopStep {
            phase: "observe",
            tool: "read-context",
            input: String::new(),
            required_permission: PermissionMode::ReadOnly,
        },
        AgentLoopStep {
            phase: "inspect",
            tool: "file-tree",
            input: String::from(". 2"),
            required_permission: PermissionMode::ReadOnly,
        },
        AgentLoopStep {
            phase: "plan",
            tool: "workflow-plan",
            input: goal.clone(),
            required_permission: PermissionMode::ReadOnly,
        },
        AgentLoopStep {
            phase: "validate",
            tool: "git-status",
            input: String::new(),
            required_permission: PermissionMode::ReadOnly,
        },
    ]
}

pub fn execute_bounded_agent_loop<R: AgentLoopSessionRuntime>(
    runtime: &R,
    session_id: &str,
    goal: &str,
) -> Result<AgentLoopReport, OctoError> {
    let goal = normalize_goal(goal);
    let (skill_slug, _stripped_goal) = parse_skill_attribution(&goal);
    runtime.append_agent_loop_message(
        session_id,
        ConversationRole::System,
        format!("agent-loop start: {goal}"),
    )?;

    let mut reports = Vec::new();
    let mut stopped_reason = String::from("completed bounded observe-plan-act-validate loop");

    for step in build_bounded_agent_loop(&goal) {
        runtime.append_agent_loop_message(
            session_id,
            ConversationRole::Tool,
            format!(
                "agent-loop phase={} tool={} input={}",
                step.phase,
                step.tool,
                if step.input.is_empty() { "<empty>" } else { &step.input }
            ),
        )?;

        let result = runtime.run_agent_loop_tool(
            session_id,
            ToolCall {
                name: String::from(step.tool),
                input: step.input.clone(),
                permission: step.required_permission.clone(),
            },
        );

        match result {
            Ok(result) => {
                let clipped = clip_output(&result.output, 2400);
                reports.push(AgentLoopStepReport {
                    phase: String::from(step.phase),
                    tool: String::from(step.tool),
                    input: step.input,
                    ok: true,
                    output: clipped.clone(),
                });
                runtime.append_agent_loop_message(
                    session_id,
                    ConversationRole::Tool,
                    format!("agent-loop result {} => {}", step.phase, clipped),
                )?;
            }
            Err(error) => {
                stopped_reason = format!("stopped on {} tool error: {error}", step.phase);
                reports.push(AgentLoopStepReport {
                    phase: String::from(step.phase),
                    tool: String::from(step.tool),
                    input: step.input,
                    ok: false,
                    output: error.to_string(),
                });
                runtime.append_agent_loop_message(
                    session_id,
                    ConversationRole::System,
                    stopped_reason.clone(),
                )?;
                break;
            }
        }
    }

    let report = AgentLoopReport {
        goal,
        steps: reports,
        stopped_reason,
    };
    if let Some(slug) = skill_slug.as_deref() {
        let success = report.steps.iter().all(|s| s.ok) && !report.steps.is_empty();
        runtime.record_skill_outcome(session_id, slug, success)?;
    }
    runtime.append_agent_loop_message(
        session_id,
        ConversationRole::Assistant,
        render_agent_loop_report(&report),
    )?;
    Ok(report)
}

pub fn render_agent_loop_report(report: &AgentLoopReport) -> String {
    let mut lines = vec![
        format!("agent-loop completed for: {}", report.goal),
        format!("stopped: {}", report.stopped_reason),
        String::from("steps:"),
    ];
    for step in &report.steps {
        lines.push(format!(
            "- {} / {} / ok={} / input={}",
            step.phase,
            step.tool,
            step.ok,
            if step.input.is_empty() { "<empty>" } else { &step.input }
        ));
    }
    lines.join("\n")
}

fn normalize_goal(goal: &str) -> String {
    let goal = goal.trim();
    if goal.is_empty() {
        String::from("continue current task")
    } else {
        goal.lines().next().unwrap_or(goal).trim().to_string()
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
    use super::*;
    use std::cell::RefCell;

    struct FakeRuntime {
        messages: RefCell<Vec<String>>,
        skill_calls: RefCell<Vec<(String, bool)>>,
        fail_on: Option<&'static str>,
    }

    impl AgentLoopSessionRuntime for FakeRuntime {
        fn append_agent_loop_message(
            &self,
            _session_id: &str,
            _role: ConversationRole,
            content: String,
        ) -> Result<(), OctoError> {
            self.messages.borrow_mut().push(content);
            Ok(())
        }

        fn run_agent_loop_tool(
            &self,
            _session_id: &str,
            call: ToolCall,
        ) -> Result<ToolResult, OctoError> {
            if let Some(fail) = self.fail_on {
                if call.name == fail {
                    return Err(OctoError::Runtime(format!("forced failure on {}", fail)));
                }
            }
            Ok(ToolResult {
                output: format!("{}:{}", call.name, call.input),
            })
        }

        fn record_skill_outcome(
            &self,
            _session_id: &str,
            slug: &str,
            success: bool,
        ) -> Result<(), OctoError> {
            self.skill_calls.borrow_mut().push((slug.to_string(), success));
            Ok(())
        }
    }

    fn fake() -> FakeRuntime {
        FakeRuntime {
            messages: RefCell::new(Vec::new()),
            skill_calls: RefCell::new(Vec::new()),
            fail_on: None,
        }
    }

    #[test]
    fn builds_four_step_bounded_loop() {
        let steps = build_bounded_agent_loop("ship it");
        assert_eq!(steps.len(), 4);
        assert_eq!(steps[0].tool, "read-context");
        assert_eq!(steps[3].tool, "git-status");
    }

    #[test]
    fn executes_loop_and_appends_summary() {
        let runtime = fake();
        let report = execute_bounded_agent_loop(&runtime, "demo", "ship it").expect("loop ok");
        assert_eq!(report.steps.len(), 4);
        assert!(runtime.messages.borrow().iter().any(|m| m.contains("agent-loop completed")));
        // No skill prefix => no skill outcome recorded.
        assert!(runtime.skill_calls.borrow().is_empty());
    }

    #[test]
    fn parse_skill_attribution_extracts_slug_and_remainder() {
        let (slug, body) = parse_skill_attribution("[skill:auto-research] explore X");
        assert_eq!(slug.as_deref(), Some("auto-research"));
        assert_eq!(body, "explore X");
        let (slug, _) = parse_skill_attribution("plain goal");
        assert!(slug.is_none());
        let (slug, _) = parse_skill_attribution("[skill:bad slug] hi");
        assert!(slug.is_none(), "spaces in slug must be rejected");
    }

    #[test]
    fn skill_outcome_recorded_on_success() {
        let runtime = fake();
        let _ = execute_bounded_agent_loop(&runtime, "demo", "[skill:demo-skill] do thing")
            .expect("loop ok");
        let calls = runtime.skill_calls.borrow().clone();
        assert_eq!(calls, vec![(String::from("demo-skill"), true)]);
    }

    #[test]
    fn skill_outcome_recorded_as_failure_when_step_errors() {
        let mut runtime = fake();
        runtime.fail_on = Some("file-tree");
        let _ = execute_bounded_agent_loop(&runtime, "demo", "[skill:flaky] try")
            .expect("loop ok");
        let calls = runtime.skill_calls.borrow().clone();
        assert_eq!(calls, vec![(String::from("flaky"), false)]);
    }
}
