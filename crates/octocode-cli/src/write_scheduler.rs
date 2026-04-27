use std::collections::{BTreeMap, BTreeSet};

use crate::sub_loop::WriteQueueItem;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitDecision {
    Execute,
    SkipDuplicate,
    Conflict,
}

#[derive(Debug, Clone)]
pub struct CommitPlanItem {
    pub item: WriteQueueItem,
    pub decision: CommitDecision,
    pub target_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct CommitPlan {
    pub items: Vec<CommitPlanItem>,
}

impl CommitPlan {
    pub fn executable_items(&self) -> Vec<WriteQueueItem> {
        self.items
            .iter()
            .filter(|item| item.decision == CommitDecision::Execute)
            .map(|item| item.item.clone())
            .collect()
    }

    pub fn render(&self) -> String {
        self.items
            .iter()
            .map(|item| {
                format!(
                    "[commit-plan {:?} target={} tool={} subLoop={} reason={}]",
                    item.decision,
                    item.target_key,
                    item.item.tool,
                    item.item.sub_loop_id,
                    item.reason
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn schedule_write_queue(queue: Vec<WriteQueueItem>) -> CommitPlan {
    let mut queue = queue;
    queue.sort_by(|a, b| {
        risk_rank(&a.tool)
            .cmp(&risk_rank(&b.tool))
            .then_with(|| target_key(a).cmp(&target_key(b)))
            .then_with(|| a.sub_loop_id.cmp(&b.sub_loop_id))
    });

    let mut seen_exact = BTreeSet::new();
    let mut target_writers: BTreeMap<String, String> = BTreeMap::new();
    let mut items = Vec::new();

    for item in queue {
        let target = target_key(&item);
        let exact = format!("{}\u{1f}{}\u{1f}{}", item.tool, target, item.input);
        if !seen_exact.insert(exact) {
            items.push(CommitPlanItem {
                item,
                decision: CommitDecision::SkipDuplicate,
                target_key: target,
                reason: String::from("duplicate write queue item"),
            });
            continue;
        }

        if item.tool == "write-file" || item.tool == "append-file" {
            if let Some(existing) = target_writers.get(&target) {
                items.push(CommitPlanItem {
                    item,
                    decision: CommitDecision::Conflict,
                    target_key: target,
                    reason: format!("target already claimed by {existing}"),
                });
                continue;
            }
            target_writers.insert(target.clone(), item.sub_loop_id.clone());
        }

        items.push(CommitPlanItem {
            item,
            decision: CommitDecision::Execute,
            target_key: target,
            reason: String::from("scheduled for serialized parent commit"),
        });
    }

    CommitPlan { items }
}

fn risk_rank(tool: &str) -> u8 {
    match tool {
        "append-file" => 10,
        "write-file" => 20,
        "shell-command" => 90,
        _ => 50,
    }
}

fn target_key(item: &WriteQueueItem) -> String {
    match item.tool.as_str() {
        "write-file" | "append-file" => item
            .input
            .split_once('|')
            .map(|(path, _)| path.trim().to_string())
            .unwrap_or_else(|| item.input.trim().to_string()),
        "shell-command" => format!("shell:{}", item.input.trim()),
        _ => item.input.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{schedule_write_queue, CommitDecision};
    use crate::sub_loop::WriteQueueItem;

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
    fn skips_duplicate_items() {
        let plan = schedule_write_queue(vec![
            item("a", "append-file", "README.md|x"),
            item("a", "append-file", "README.md|x"),
        ]);
        assert_eq!(plan.items[0].decision, CommitDecision::Execute);
        assert_eq!(plan.items[1].decision, CommitDecision::SkipDuplicate);
    }

    #[test]
    fn marks_same_file_conflict() {
        let plan = schedule_write_queue(vec![
            item("a", "write-file", "README.md|x"),
            item("b", "write-file", "README.md|y"),
        ]);
        assert!(plan.items.iter().any(|i| i.decision == CommitDecision::Conflict));
    }
}
