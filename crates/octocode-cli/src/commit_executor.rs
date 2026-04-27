use octocode_core::{PermissionMode, ToolCall};

use crate::sub_loop::WriteQueueItem;
use crate::write_scheduler::{CommitDecision, CommitPlan};

const MAX_HEAL_ATTEMPTS: usize = 1;

#[derive(Debug, Clone)]
pub struct CommitExecutionResult {
    pub sub_loop_id: String,
    pub session_id: String,
    pub tool: String,
    pub input: String,
    pub decision: CommitDecision,
    pub ok: bool,
    pub output: String,
    pub retries: usize,
    pub heal_strategy: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CommitExecutionReport {
    pub results: Vec<CommitExecutionResult>,
}

impl CommitExecutionReport {
    pub fn ok_count(&self) -> usize {
        self.results.iter().filter(|result| result.ok).count()
    }

    pub fn conflict_count(&self) -> usize {
        self.results
            .iter()
            .filter(|result| result.decision == CommitDecision::Conflict)
            .count()
    }

    pub fn skipped_count(&self) -> usize {
        self.results
            .iter()
            .filter(|result| result.decision == CommitDecision::SkipDuplicate)
            .count()
    }

    pub fn healed_count(&self) -> usize {
        self.results
            .iter()
            .filter(|result| result.heal_strategy.is_some() && result.ok)
            .count()
    }

    pub fn render(&self) -> String {
        self.results
            .iter()
            .map(|result| {
                format!(
                    "[commit-exec {:?} ok={} retries={} heal={} subLoop={} tool={} input={} output={}]",
                    result.decision,
                    result.ok,
                    result.retries,
                    result.heal_strategy.as_deref().unwrap_or("none"),
                    result.sub_loop_id,
                    result.tool,
                    clip(&result.input, 220),
                    clip(&result.output, 500)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub trait CommitRuntime {
    fn run_commit_tool(&mut self, session_id: &str, call: ToolCall) -> Result<String, String>;
}

pub fn execute_commit_plan<R: CommitRuntime>(
    runtime: &mut R,
    parent_session_id: &str,
    plan: CommitPlan,
) -> CommitExecutionReport {
    let mut report = CommitExecutionReport::default();

    for item in plan.items {
        match item.decision {
            CommitDecision::Execute => {
                let initial = CommitAttempt {
                    tool: item.item.tool.clone(),
                    input: item.item.input.clone(),
                    strategy: None,
                };
                let execution = execute_with_self_heal(runtime, parent_session_id, initial);
                report.results.push(result_from_item(
                    item.item,
                    CommitDecision::Execute,
                    execution.ok,
                    execution.output,
                    execution.retries,
                    execution.strategy,
                ));
            }
            CommitDecision::SkipDuplicate => report.results.push(result_from_item(
                item.item,
                CommitDecision::SkipDuplicate,
                true,
                String::from("skipped duplicate scheduled write"),
                0,
                None,
            )),
            CommitDecision::Conflict => report.results.push(result_from_item(
                item.item,
                CommitDecision::Conflict,
                false,
                item.reason,
                0,
                None,
            )),
        }
    }

    report
}

#[derive(Debug, Clone)]
struct CommitAttempt {
    tool: String,
    input: String,
    strategy: Option<String>,
}

#[derive(Debug, Clone)]
struct CommitAttemptResult {
    ok: bool,
    output: String,
    retries: usize,
    strategy: Option<String>,
}

fn execute_with_self_heal<R: CommitRuntime>(
    runtime: &mut R,
    parent_session_id: &str,
    initial: CommitAttempt,
) -> CommitAttemptResult {
    let mut last_error = None;
    let mut attempt = initial.clone();

    for retry in 0..=MAX_HEAL_ATTEMPTS {
        let result = runtime.run_commit_tool(
            parent_session_id,
            ToolCall {
                name: attempt.tool.clone(),
                input: attempt.input.clone(),
                permission: permission_for_tool(&attempt.tool),
            },
        );

        match result {
            Ok(output) => {
                return CommitAttemptResult {
                    ok: true,
                    output,
                    retries: retry,
                    strategy: attempt.strategy,
                };
            }
            Err(error) => {
                last_error = Some(error.clone());
                if retry >= MAX_HEAL_ATTEMPTS {
                    break;
                }
                let Some(next) = build_heal_attempt(&initial, &error) else {
                    break;
                };
                if next.tool == attempt.tool && next.input == attempt.input {
                    break;
                }
                attempt = next;
            }
        }
    }

    CommitAttemptResult {
        ok: false,
        output: last_error.unwrap_or_else(|| String::from("unknown error")),
        retries: MAX_HEAL_ATTEMPTS,
        strategy: attempt.strategy,
    }
}

fn build_heal_attempt(original: &CommitAttempt, error: &str) -> Option<CommitAttempt> {
    let lower = error.to_ascii_lowercase();
    match original.tool.as_str() {
        "write-file" if lower.contains("parent") || lower.contains("directory") || lower.contains("no such file") => {
            Some(CommitAttempt {
                tool: String::from("shell-command"),
                input: mkdir_parent_command(&original.input)?,
                strategy: Some(String::from("create-parent-directory-before-write")),
            })
        }
        "write-file" if lower.contains("permission") || lower.contains("readonly") => {
            Some(CommitAttempt {
                tool: String::from("append-file"),
                input: original.input.clone(),
                strategy: Some(String::from("downgrade-write-to-append")),
            })
        }
        "append-file" if lower.contains("no such file") || lower.contains("not found") => {
            Some(CommitAttempt {
                tool: String::from("write-file"),
                input: original.input.clone(),
                strategy: Some(String::from("create-file-via-write")),
            })
        }
        "shell-command" if lower.contains("timeout") || lower.contains("busy") || lower.contains("temporarily") => {
            Some(CommitAttempt {
                tool: original.tool.clone(),
                input: format!("{} # self-heal-retry", original.input),
                strategy: Some(String::from("retry-transient-shell")),
            })
        }
        _ => None,
    }
}

fn mkdir_parent_command(write_input: &str) -> Option<String> {
    let path = write_input.split_once('|').map(|(path, _)| path.trim()).unwrap_or(write_input.trim());
    if path.is_empty() || path.contains("..") {
        return None;
    }
    let parent = path.rsplit_once(['/', '\\']).map(|(parent, _)| parent.trim())?;
    if parent.is_empty() {
        return None;
    }
    Some(format!("mkdir -p {}", shell_quote(parent)))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn result_from_item(
    item: WriteQueueItem,
    decision: CommitDecision,
    ok: bool,
    output: String,
    retries: usize,
    heal_strategy: Option<String>,
) -> CommitExecutionResult {
    CommitExecutionResult {
        sub_loop_id: item.sub_loop_id,
        session_id: item.session_id,
        tool: item.tool,
        input: item.input,
        decision,
        ok,
        output,
        retries,
        heal_strategy,
    }
}

fn permission_for_tool(tool: &str) -> PermissionMode {
    match tool {
        "write-file" | "append-file" => PermissionMode::WorkspaceWrite,
        "shell-command" => PermissionMode::DangerFullAccess,
        _ => PermissionMode::ReadOnly,
    }
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
    use super::{execute_commit_plan, CommitRuntime};
    use crate::sub_loop::WriteQueueItem;
    use crate::write_scheduler::schedule_write_queue;
    use octocode_core::ToolCall;

    struct ParentDirHealingRuntime {
        attempts: usize,
    }

    impl CommitRuntime for ParentDirHealingRuntime {
        fn run_commit_tool(&mut self, _session_id: &str, call: ToolCall) -> Result<String, String> {
            self.attempts += 1;
            if self.attempts == 1 {
                Err(String::from("parent directory missing"))
            } else {
                Ok(format!("{}:{}", call.name, call.input))
            }
        }
    }

    fn item(id: &str, tool: &str, input: &str) -> WriteQueueItem {
        WriteQueueItem {
            sub_loop_id: id.to_string(),
            session_id: format!("demo-{id}"),
            tool: tool.to_string(),
            input: input.to_string(),
            reason: String::from("test"),
        }
    }

    #[test]
    fn heals_missing_parent_by_creating_directory() {
        let plan = schedule_write_queue(vec![item("a", "write-file", "docs/new/file.md|x")]);
        let mut runtime = ParentDirHealingRuntime { attempts: 0 };
        let report = execute_commit_plan(&mut runtime, "demo", plan);
        assert_eq!(report.ok_count(), 1);
        assert_eq!(report.healed_count(), 1);
        assert!(report.render().contains("create-parent-directory-before-write"));
    }
}
