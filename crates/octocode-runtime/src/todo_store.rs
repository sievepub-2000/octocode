use std::fs;
use std::path::{Path, PathBuf};

use octocode_core::OctoError;

/// A persistent todo item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    pub id: u32,
    pub text: String,
    pub done: bool,
}

/// Manages a per-workspace persistent todo list stored in `.octocode/todos.tsv`.
#[derive(Debug, Clone)]
pub struct TodoStore {
    file_path: PathBuf,
}

impl TodoStore {
    pub fn new(workspace_root: &Path) -> Self {
        Self {
            file_path: workspace_root.join(".octocode").join("todos.tsv"),
        }
    }

    pub fn list(&self) -> Result<Vec<TodoItem>, OctoError> {
        if !self.file_path.is_file() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.file_path)
            .map_err(|e| OctoError::Runtime(format!("todo-list read: {e}")))?;
        let mut items = Vec::new();
        for line in raw.lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() >= 3 {
                if let Ok(id) = parts[0].parse::<u32>() {
                    items.push(TodoItem {
                        id,
                        done: parts[1] == "done",
                        text: String::from(parts[2]),
                    });
                }
            }
        }
        Ok(items)
    }

    pub fn add(&self, text: &str) -> Result<TodoItem, OctoError> {
        let mut items = self.list()?;
        let id = items.iter().map(|i| i.id).max().unwrap_or(0) + 1;
        let item = TodoItem {
            id,
            text: String::from(text),
            done: false,
        };
        items.push(item.clone());
        self.save(&items)?;
        Ok(item)
    }

    pub fn complete(&self, id: u32) -> Result<bool, OctoError> {
        let mut items = self.list()?;
        let found = items.iter_mut().find(|i| i.id == id);
        if let Some(item) = found {
            item.done = true;
            self.save(&items)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn remove(&self, id: u32) -> Result<bool, OctoError> {
        let mut items = self.list()?;
        let len_before = items.len();
        items.retain(|i| i.id != id);
        if items.len() < len_before {
            self.save(&items)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn save(&self, items: &[TodoItem]) -> Result<(), OctoError> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| OctoError::Runtime(format!("todo-store mkdir: {e}")))?;
        }
        let body: String = items
            .iter()
            .map(|i| {
                format!(
                    "{}\t{}\t{}",
                    i.id,
                    if i.done { "done" } else { "pending" },
                    i.text.replace(['\t', '\n'], " ")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let content = if body.is_empty() { String::new() } else { format!("{body}\n") };
        // Atomic write: write to temp file then rename to avoid corruption.
        let tmp_path = self.file_path.with_extension("tsv.tmp");
        fs::write(&tmp_path, &content)
            .map_err(|e| OctoError::Runtime(format!("todo-store write tmp: {e}")))?;
        fs::rename(&tmp_path, &self.file_path)
            .map_err(|e| OctoError::Runtime(format!("todo-store rename: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> TodoStore {
        let dir = std::env::temp_dir()
            .join(format!("octocode_todo_test_{}_{}", std::process::id(), name));
        // Clean from previous run
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        TodoStore::new(&dir)
    }

    #[test]
    fn add_and_list() {
        let store = temp_store("add_and_list");
        let item = store.add("write tests").unwrap();
        assert_eq!(item.id, 1);
        assert!(!item.done);
        let items = store.list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "write tests");
    }

    #[test]
    fn complete_item() {
        let store = temp_store("complete_item");
        let item = store.add("deploy").unwrap();
        assert!(store.complete(item.id).unwrap());
        let items = store.list().unwrap();
        assert!(items[0].done);
    }

    #[test]
    fn remove_item() {
        let store = temp_store("remove_item");
        let item = store.add("delete me").unwrap();
        assert!(store.remove(item.id).unwrap());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn empty_list_no_file() {
        let store = TodoStore::new(Path::new("/nonexistent/path"));
        assert!(store.list().unwrap().is_empty());
    }
}
