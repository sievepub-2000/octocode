//! Sub-agent system — spawn independent agent instances for parallel task execution.
//! Similar to Claude Code v3's Task tool for delegating work to sub-agents.
//!
//! Architecture:
//! - SubAgentManager: tracks tasks, enforces concurrency limits
//! - SubAgentExecutor: thread-pool based executor for running agent goals in parallel
//! - Communication via channels: each task gets a result sender

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use octocode_core::OctoError;

static SUBAGENT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// State of a sub-agent execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubAgentState {
    Running,
    Completed,
    Failed,
    TimedOut,
}

/// A sub-agent task record.
#[derive(Debug, Clone)]
pub struct SubAgentTask {
    pub id: String,
    pub goal: String,
    pub state: SubAgentState,
    pub created_at_ms: u128,
    pub finished_at_ms: Option<u128>,
    pub result: Option<String>,
    pub error: Option<String>,
}

/// Callback type for sub-agent work execution.
/// Takes a goal string and returns Ok(result) or Err(error).
pub type SubAgentWorkFn = Box<dyn FnOnce(String) -> Result<String, String> + Send + 'static>;

/// Thread-pool based executor for sub-agent tasks.
pub struct SubAgentExecutor {
    sender: mpsc::Sender<ExecutorJob>,
    _workers: Vec<thread::JoinHandle<()>>,
}

struct ExecutorJob {
    task_id: String,
    goal: String,
    work_fn: SubAgentWorkFn,
    result_tx: mpsc::Sender<ExecutorResult>,
}

/// Result from a completed executor job.
#[derive(Debug)]
pub struct ExecutorResult {
    pub task_id: String,
    pub outcome: Result<String, String>,
}

impl SubAgentExecutor {
    /// Create a new executor with a fixed thread pool.
    pub fn new(pool_size: usize) -> Self {
        let (sender, receiver) = mpsc::channel::<ExecutorJob>();
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::with_capacity(pool_size);

        for i in 0..pool_size {
            let rx = Arc::clone(&receiver);
            let handle = thread::Builder::new()
                .name(format!("subagent-worker-{i}"))
                .spawn(move || loop {
                    let job = {
                        let lock = rx.lock().expect("executor mutex poisoned");
                        lock.recv()
                    };
                    match job {
                        Ok(job) => {
                            let outcome = (job.work_fn)(job.goal);
                            let _ = job.result_tx.send(ExecutorResult {
                                task_id: job.task_id,
                                outcome,
                            });
                        }
                        Err(_) => break, // Channel closed
                    }
                })
                .expect("failed to spawn subagent worker");
            workers.push(handle);
        }

        Self {
            sender,
            _workers: workers,
        }
    }

    /// Submit a job to the executor. Returns a receiver for the result.
    pub fn submit(
        &self,
        task_id: String,
        goal: String,
        work_fn: SubAgentWorkFn,
    ) -> mpsc::Receiver<ExecutorResult> {
        let (result_tx, result_rx) = mpsc::channel();
        let job = ExecutorJob {
            task_id,
            goal,
            work_fn,
            result_tx,
        };
        self.sender.send(job).expect("executor channel closed");
        result_rx
    }
}

impl Default for SubAgentExecutor {
    fn default() -> Self {
        Self::new(4)
    }
}

/// Sub-agent manager that tracks and orchestrates spawned agent instances.
#[allow(clippy::type_complexity)]
pub struct SubAgentManager {
    tasks: Arc<Mutex<Vec<SubAgentTask>>>,
    max_concurrent: usize,
    timeout: Duration,
    /// Receivers for pending task results from the executor.
    pending_results: Arc<Mutex<Vec<(String, mpsc::Receiver<ExecutorResult>)>>>,
}

impl SubAgentManager {
    pub fn new(max_concurrent: usize, timeout_secs: u64) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(Vec::new())),
            max_concurrent,
            timeout: Duration::from_secs(timeout_secs),
            pending_results: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Spawn a new sub-agent task. Returns the task ID.
    pub fn spawn(&self, goal: &str) -> Result<String, OctoError> {
        let running_count = self.tasks.lock().unwrap()
            .iter()
            .filter(|t| t.state == SubAgentState::Running)
            .count();

        if running_count >= self.max_concurrent {
            return Err(OctoError::Runtime(format!(
                "max concurrent sub-agents reached ({}/{})",
                running_count, self.max_concurrent
            )));
        }

        let id = format!("subagent-{}", SUBAGENT_COUNTER.fetch_add(1, Ordering::Relaxed));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let task = SubAgentTask {
            id: id.clone(),
            goal: goal.to_string(),
            state: SubAgentState::Running,
            created_at_ms: now,
            finished_at_ms: None,
            result: None,
            error: None,
        };

        self.tasks.lock().unwrap().push(task);
        Ok(id)
    }

    /// Spawn a sub-agent and submit work to an executor for real parallel execution.
    pub fn spawn_with_executor(
        &self,
        goal: &str,
        executor: &SubAgentExecutor,
        work_fn: SubAgentWorkFn,
    ) -> Result<String, OctoError> {
        let id = self.spawn(goal)?;
        let rx = executor.submit(id.clone(), goal.to_string(), work_fn);
        if let Ok(mut pending) = self.pending_results.lock() {
            pending.push((id.clone(), rx));
        }
        Ok(id)
    }

    /// Poll pending results and update task states.
    /// Returns IDs of tasks that have completed since last poll.
    pub fn poll_results(&self) -> Vec<String> {
        let mut completed_ids = Vec::new();
        let mut pending = self.pending_results.lock().unwrap();

        pending.retain(|(task_id, rx)| {
            match rx.try_recv() {
                Ok(result) => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(task) = tasks.iter_mut().find(|t| t.id == *task_id) {
                        match result.outcome {
                            Ok(output) => {
                                task.state = SubAgentState::Completed;
                                task.result = Some(output);
                            }
                            Err(err) => {
                                task.state = SubAgentState::Failed;
                                task.error = Some(err);
                            }
                        }
                        task.finished_at_ms = Some(now);
                    }
                    completed_ids.push(task_id.clone());
                    false // Remove from pending
                }
                Err(mpsc::TryRecvError::Empty) => true, // Still pending
                Err(mpsc::TryRecvError::Disconnected) => {
                    // Worker dropped without sending — mark as failed
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(task) = tasks.iter_mut().find(|t| t.id == *task_id) {
                        task.state = SubAgentState::Failed;
                        task.error = Some("worker disconnected".into());
                        task.finished_at_ms = Some(now);
                    }
                    completed_ids.push(task_id.clone());
                    false
                }
            }
        });

        completed_ids
    }

    /// Block until a specific task completes, with timeout.
    pub fn wait_for(&self, task_id: &str) -> Result<SubAgentTask, OctoError> {
        let deadline = SystemTime::now() + self.timeout;
        loop {
            self.poll_results();
            if let Some(task) = self.status(task_id) {
                if task.state != SubAgentState::Running {
                    return Ok(task);
                }
            } else {
                return Err(OctoError::Runtime(format!("task {task_id} not found")));
            }
            if SystemTime::now() >= deadline {
                // Timeout — mark as timed out
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
                    task.state = SubAgentState::TimedOut;
                    task.finished_at_ms = Some(now);
                    task.error = Some(format!("timed out after {}s", self.timeout.as_secs()));
                }
                return Err(OctoError::Runtime(format!(
                    "task {task_id} timed out after {}s",
                    self.timeout.as_secs()
                )));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Complete a sub-agent task with a result.
    pub fn complete(&self, id: &str, result: String) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.iter_mut().find(|t| t.id == id && t.state == SubAgentState::Running) {
            task.state = SubAgentState::Completed;
            task.finished_at_ms = Some(now);
            task.result = Some(result);
            true
        } else {
            false
        }
    }

    /// Fail a sub-agent task with an error.
    pub fn fail(&self, id: &str, error: String) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.iter_mut().find(|t| t.id == id && t.state == SubAgentState::Running) {
            task.state = SubAgentState::Failed;
            task.finished_at_ms = Some(now);
            task.error = Some(error);
            true
        } else {
            false
        }
    }

    /// Get the status of a sub-agent task.
    pub fn status(&self, id: &str) -> Option<SubAgentTask> {
        self.tasks.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }

    /// List all sub-agent tasks, optionally filtered by state.
    pub fn list(&self, state_filter: Option<SubAgentState>) -> Vec<SubAgentTask> {
        let tasks = self.tasks.lock().unwrap();
        match state_filter {
            Some(state) => tasks.iter().filter(|t| t.state == state).cloned().collect(),
            None => tasks.clone(),
        }
    }

    /// Clean up completed/failed tasks older than the specified duration.
    pub fn gc(&self, max_age: Duration) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let cutoff = now.saturating_sub(max_age.as_millis());

        let mut tasks = self.tasks.lock().unwrap();
        tasks.retain(|t| {
            t.state == SubAgentState::Running || t.created_at_ms > cutoff
        });
    }

    /// Get a summary suitable for the agent context.
    pub fn summary(&self) -> String {
        let tasks = self.tasks.lock().unwrap();
        if tasks.is_empty() {
            return String::from("No sub-agent tasks.");
        }
        let running = tasks.iter().filter(|t| t.state == SubAgentState::Running).count();
        let completed = tasks.iter().filter(|t| t.state == SubAgentState::Completed).count();
        let failed = tasks.iter().filter(|t| t.state == SubAgentState::Failed).count();
        format!(
            "Sub-agents: {} running, {} completed, {} failed (total: {})",
            running, completed, failed, tasks.len()
        )
    }
}

impl Default for SubAgentManager {
    fn default() -> Self {
        Self::new(4, 300)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_and_complete() {
        let manager = SubAgentManager::new(2, 60);
        let id = manager.spawn("test goal").unwrap();
        assert!(manager.status(&id).is_some());
        assert_eq!(manager.status(&id).unwrap().state, SubAgentState::Running);

        manager.complete(&id, "done".into());
        assert_eq!(manager.status(&id).unwrap().state, SubAgentState::Completed);
        assert_eq!(manager.status(&id).unwrap().result, Some("done".into()));
    }

    #[test]
    fn test_max_concurrent() {
        let manager = SubAgentManager::new(1, 60);
        let _id1 = manager.spawn("task 1").unwrap();
        let result = manager.spawn("task 2");
        assert!(result.is_err());
    }

    #[test]
    fn test_fail() {
        let manager = SubAgentManager::new(4, 60);
        let id = manager.spawn("failing task").unwrap();
        manager.fail(&id, "something went wrong".into());
        assert_eq!(manager.status(&id).unwrap().state, SubAgentState::Failed);
    }

    #[test]
    fn test_list_filter() {
        let manager = SubAgentManager::new(4, 60);
        let id1 = manager.spawn("task 1").unwrap();
        let _id2 = manager.spawn("task 2").unwrap();
        manager.complete(&id1, "done".into());

        assert_eq!(manager.list(Some(SubAgentState::Running)).len(), 1);
        assert_eq!(manager.list(Some(SubAgentState::Completed)).len(), 1);
        assert_eq!(manager.list(None).len(), 2);
    }

    #[test]
    fn test_executor_runs_work_in_parallel() {
        let executor = SubAgentExecutor::new(2);
        let manager = SubAgentManager::new(4, 10);

        let id1 = manager.spawn_with_executor("compute pi", &executor, Box::new(|goal| {
            Ok(format!("done: {}", goal))
        })).unwrap();

        let id2 = manager.spawn_with_executor("compute e", &executor, Box::new(|goal| {
            Ok(format!("done: {}", goal))
        })).unwrap();

        // Wait a bit for workers to complete
        thread::sleep(Duration::from_millis(50));
        manager.poll_results();

        let t1 = manager.status(&id1).unwrap();
        let t2 = manager.status(&id2).unwrap();
        assert_eq!(t1.state, SubAgentState::Completed);
        assert_eq!(t2.state, SubAgentState::Completed);
        assert_eq!(t1.result.as_deref(), Some("done: compute pi"));
        assert_eq!(t2.result.as_deref(), Some("done: compute e"));
    }

    #[test]
    fn test_executor_handles_failure() {
        let executor = SubAgentExecutor::new(1);
        let manager = SubAgentManager::new(4, 10);

        let id = manager.spawn_with_executor("will fail", &executor, Box::new(|_| {
            Err("something went wrong".into())
        })).unwrap();

        thread::sleep(Duration::from_millis(50));
        manager.poll_results();

        let task = manager.status(&id).unwrap();
        assert_eq!(task.state, SubAgentState::Failed);
        assert_eq!(task.error.as_deref(), Some("something went wrong"));
    }

    #[test]
    fn test_wait_for_blocks_until_complete() {
        let executor = SubAgentExecutor::new(1);
        let manager = SubAgentManager::new(4, 5);

        let id = manager.spawn_with_executor("slow task", &executor, Box::new(|_| {
            thread::sleep(Duration::from_millis(20));
            Ok("finished".into())
        })).unwrap();

        let result = manager.wait_for(&id).unwrap();
        assert_eq!(result.state, SubAgentState::Completed);
        assert_eq!(result.result.as_deref(), Some("finished"));
    }
}
