use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Debug, Clone)]
pub struct SubTask {
    pub id: String,
    pub goal: String,
}

pub fn plan_sub_tasks(goal: &str) -> Vec<SubTask> {
    let mut tasks = Vec::new();
    for (i, part) in goal
        .split(|c| c == ';' || c == '\n')
        .flat_map(|s| s.split(" and "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
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

// 🔥 NEW: parallel execution (read-only safe + serialized write phase)
pub fn run_parallel_execution(tasks: Vec<SubTask>) -> Vec<String> {
    let results = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::new();

    for task in tasks {
        let results = Arc::clone(&results);

        handles.push(thread::spawn(move || {
            // 🔒 SAFE: simulate read-only / planning execution
            let output = format!("[exec:{}] {}", task.id, task.goal);

            let mut guard = results.lock().unwrap();
            guard.push(output);
        }));
    }

    for h in handles {
        let _ = h.join();
    }

    Arc::try_unwrap(results).unwrap().into_inner().unwrap()
}

#[cfg(test)]
mod tests {
    use super::{plan_sub_tasks, run_parallel_execution};

    #[test]
    fn parallel_exec_runs() {
        let tasks = plan_sub_tasks("a; b; c");
        let out = run_parallel_execution(tasks);
        assert!(out.len() >= 3);
    }
}
