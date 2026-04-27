use std::thread;

#[derive(Debug, Clone)]
pub struct SubTask {
    pub id: String,
    pub goal: String,
}

pub fn plan_sub_tasks(goal: &str) -> Vec<SubTask> {
    // naive splitter: split by ';' or 'and'
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

pub fn run_parallel_planning(goal: &str) -> Vec<String> {
    let tasks = plan_sub_tasks(goal);
    let mut handles = Vec::new();

    for task in tasks {
        handles.push(thread::spawn(move || {
            // lightweight "planning" simulation (no runtime mutation here)
            format!("[plan:{}] {}", task.id, task.goal)
        }));
    }

    let mut results = Vec::new();
    for h in handles {
        if let Ok(r) = h.join() {
            results.push(r);
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::plan_sub_tasks;

    #[test]
    fn splits_goal_into_subtasks() {
        let tasks = plan_sub_tasks("search code; fix bug and write test");
        assert!(tasks.len() >= 2);
    }
}
