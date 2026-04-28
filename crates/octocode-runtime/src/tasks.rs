use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use octocode_core::{TaskKind, TaskRecord, TaskState};

static TASK_COUNTER: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug, Clone, Default)]
pub struct TaskStore {
    inner: Arc<Mutex<Vec<TaskRecord>>>,
}

impl TaskStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn submit(&self, kind: TaskKind, session_id: &str, label: &str) -> TaskRecord {
        let n = TASK_COUNTER.fetch_add(1, Ordering::SeqCst);
        let rec = TaskRecord {
            id: format!("t-{n}"),
            kind,
            session_id: session_id.to_string(),
            label: label.to_string(),
            state: TaskState::Pending,
            created_at_ms: now_ms(),
            finished_at_ms: None,
            result_summary: None,
        };
        let mut guard = self.inner.lock().unwrap();
        guard.push(rec.clone());
        rec
    }

    pub fn list(&self, session_id: Option<&str>) -> Vec<TaskRecord> {
        let guard = self.inner.lock().unwrap();
        guard
            .iter()
            .filter(|r| session_id.is_none_or(|s| r.session_id == s))
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<TaskRecord> {
        let guard = self.inner.lock().unwrap();
        guard.iter().find(|r| r.id == id).cloned()
    }

    pub fn set_state(&self, id: &str, state: TaskState, summary: Option<String>) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(rec) = guard.iter_mut().find(|r| r.id == id) {
            rec.state = state.clone();
            rec.result_summary = summary;
            rec.finished_at_ms = if matches!(state, TaskState::Done | TaskState::Failed) {
                Some(now_ms())
            } else {
                None
            };
            true
        } else {
            false
        }
    }

    pub fn start(&self, id: &str, summary: Option<String>) -> bool {
        self.set_state(id, TaskState::Running, summary)
    }

    pub fn finish(&self, id: &str, state: TaskState, summary: Option<String>) -> bool {
        self.set_state(id, state, summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_submit_and_list() {
        let store = TaskStore::new();
        let rec = store.submit(TaskKind::Agent, "s1", "Run tests");
        assert_eq!(rec.state, TaskState::Pending);

        let list = store.list(Some("s1"));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, rec.id);
    }

    #[test]
    fn task_finish() {
        let store = TaskStore::new();
        let rec = store.submit(TaskKind::Workflow, "s2", "Deploy");
        let ok = store.finish(&rec.id, TaskState::Done, Some("OK".into()));
        assert!(ok);
        let got = store.get(&rec.id).unwrap();
        assert_eq!(got.state, TaskState::Done);
        assert_eq!(got.result_summary, Some("OK".into()));
    }

    #[test]
    fn task_list_filter_by_session() {
        let store = TaskStore::new();
        store.submit(TaskKind::Tool, "session-a", "Tool A");
        store.submit(TaskKind::Tool, "session-b", "Tool B");
        assert_eq!(store.list(Some("session-a")).len(), 1);
        assert_eq!(store.list(None).len(), 2);
    }

    #[test]
    fn task_start_sets_running_without_finish_time() {
        let store = TaskStore::new();
        let rec = store.submit(TaskKind::Agent, "s3", "Run async");
        let ok = store.start(&rec.id, Some("worker started".into()));
        assert!(ok);
        let got = store.get(&rec.id).unwrap();
        assert_eq!(got.state, TaskState::Running);
        assert_eq!(got.result_summary.as_deref(), Some("worker started"));
        assert_eq!(got.finished_at_ms, None);
    }
}
