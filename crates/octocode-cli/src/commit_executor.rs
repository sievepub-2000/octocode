use octocode_core::{PermissionMode, ToolCall};

use crate::sub_loop::WriteQueueItem;
use crate::write_scheduler::{CommitDecision, CommitPlan};

const MAX_RETRIES: usize = 1;

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

    pub fn render(&self) -> String {
        self.results
            .iter()
            .map(|result| {
                format!(
                    "[commit-exec {:?} ok={} retries={} subLoop={} tool={} input={} output={}]",
                    result.decision,
                    result.ok,
                    result.retries,
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
                let permission = permission_for_tool(&item.item.tool);
                let mut attempt = 0;
                let mut last_error = None;
                let mut success_output = None;

                while attempt <= MAX_RETRIES {
                    let result = runtime.run_commit_tool(
                        parent_session_id,
                        ToolCall {
                            name: item.item.tool.clone(),
                            input: adapt_input_for_retry(&item.item.input, attempt),
                            permission,
                        },
                    );

                    match result {
                        Ok(output) => {
                            success_output = Some(output);
                            break;
                        }
                        Err(error) => {
                            last_error = Some(error.clone());
                            if !is_retryable(&error) {
                                break;
                            }
                        }
                    }
                    attempt += 1;
                }

                if let Some(output) = success_output {
                    report.results.push(result_from_item(
                        item.item,
                        CommitDecision::Execute,
                        true,
                        output,
                        attempt,
                    ));
                } else {
                    report.results.push(result_from_item(
                        item.item,
                        CommitDecision::Execute,
                        false,
                        last_error.unwrap_or_else(|| String::from("unknown error")),
                        attempt,
                    ));
                }
            }
            CommitDecision::SkipDuplicate => report.results.push(result_from_item(
                item.item,
                CommitDecision::SkipDuplicate,
                true,
                String::from("skipped duplicate scheduled write"),
                0,
            )),
            CommitDecision::Conflict => report.results.push(result_from_item(
                item.item,
                CommitDecision::Conflict,
                false,
                item.reason,
                0,
            )),
        }
    }

    report
}

fn is_retryable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("timeout") || lower.contains("temporarily") || lower.contains("busy")
}

fn adapt_input_for_retry(input: &str, attempt: usize) -> String {
    if attempt == 0 {
        input.to_string()
    } else {
        format!("{} #retry{}", input, attempt)
    }
}

fn result_from_item(
    item: WriteQueueItem,
    decision: CommitDecision,
    ok: bool,
    output: String,
    retries: usize,
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

    struct FlakyRuntime {
        attempts: usize,
    }

    impl CommitRuntime for FlakyRuntime {
        fn run_commit_tool(&mut self, _session_id: &str, call: ToolCall) -> Result<String, String> {
            self.attempts += 1;
            if self.attempts == 1 {
                Err(String::from("timeout"))
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
    fn retries_once_on_timeout() {
        let plan = schedule_write_queue(vec![item("a", "write-file", "README.md|x")]);
        let mut runtime = FlakyRuntime { attempts: 0 };
        let report = execute_commit_plan(&mut runtime, "demo", plan);
        assert_eq!(report.ok_count(), 1);
    }
}
