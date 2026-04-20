//! Persistent memory system — stores facts/notes per-project and per-user.
//! Similar to Claude Code v3's `/memories/repo/` concept.
//!
//! Memory files are stored in `.octocode/memory/` (project) and `{config_home}/memory/` (user).
//! They can be created, listed, searched, and deleted by the agent or user.

use std::fs;
use std::path::{Path, PathBuf};

use octocode_core::OctoError;

/// A single memory entry.
#[derive(Debug, Clone)]
pub struct MemoryEntry {
    pub id: String,
    pub scope: MemoryScope,
    pub content: String,
    pub file_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryScope {
    /// Project-level memory stored in `.octocode/memory/`
    Project,
    /// User-level memory stored in config_home/memory/
    User,
}

/// Memory store managing project and user memories.
pub struct MemoryStore {
    project_dir: PathBuf,
    user_dir: PathBuf,
}

impl MemoryStore {
    pub fn new(workspace_root: &str, config_home: &Path) -> Self {
        Self {
            project_dir: PathBuf::from(workspace_root).join(".octocode").join("memory"),
            user_dir: config_home.join("memory"),
        }
    }

    /// Create or update a memory entry.
    pub fn save(&self, scope: MemoryScope, id: &str, content: &str) -> Result<PathBuf, OctoError> {
        let dir = self.dir_for_scope(&scope);
        fs::create_dir_all(&dir).map_err(|e| {
            OctoError::Runtime(format!("failed to create memory dir: {e}"))
        })?;

        let sanitized = sanitize_id(id);
        let path = dir.join(format!("{sanitized}.md"));
        fs::write(&path, content).map_err(|e| {
            OctoError::Runtime(format!("failed to write memory: {e}"))
        })?;
        Ok(path)
    }

    /// Read a memory entry by id.
    pub fn read(&self, scope: MemoryScope, id: &str) -> Result<Option<MemoryEntry>, OctoError> {
        let sanitized = sanitize_id(id);
        let path = self.dir_for_scope(&scope).join(format!("{sanitized}.md"));
        if !path.is_file() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path).map_err(|e| {
            OctoError::Runtime(format!("failed to read memory: {e}"))
        })?;
        Ok(Some(MemoryEntry {
            id: id.to_string(),
            scope,
            content,
            file_path: path,
        }))
    }

    /// Delete a memory entry.
    pub fn delete(&self, scope: MemoryScope, id: &str) -> Result<bool, OctoError> {
        let sanitized = sanitize_id(id);
        let path = self.dir_for_scope(&scope).join(format!("{sanitized}.md"));
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| {
                OctoError::Runtime(format!("failed to delete memory: {e}"))
            })?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// List all memories in a given scope.
    pub fn list(&self, scope: MemoryScope) -> Result<Vec<MemoryEntry>, OctoError> {
        let dir = self.dir_for_scope(&scope);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        let read_dir = fs::read_dir(&dir).map_err(|e| {
            OctoError::Runtime(format!("failed to list memory dir: {e}"))
        })?;
        for entry in read_dir {
            let entry = entry.map_err(|e| OctoError::Runtime(format!("readdir: {e}")))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let content = fs::read_to_string(&path).unwrap_or_default();
                entries.push(MemoryEntry {
                    id,
                    scope: scope.clone(),
                    content,
                    file_path: path,
                });
            }
        }
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(entries)
    }

    /// Search memories for a pattern (simple substring match).
    pub fn search(&self, query: &str) -> Result<Vec<MemoryEntry>, OctoError> {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        for scope in [MemoryScope::Project, MemoryScope::User] {
            for entry in self.list(scope)? {
                if entry.content.to_lowercase().contains(&query_lower)
                    || entry.id.to_lowercase().contains(&query_lower)
                {
                    results.push(entry);
                }
            }
        }
        Ok(results)
    }

    /// Load all project memories as context string for the agent.
    pub fn project_context(&self) -> Result<Option<String>, OctoError> {
        let entries = self.list(MemoryScope::Project)?;
        if entries.is_empty() {
            return Ok(None);
        }
        let mut context = String::from("=== Project Memory ===\n");
        for entry in entries.iter().take(20) {
            let preview = if entry.content.len() > 500 {
                format!("{}...", &entry.content[..500])
            } else {
                entry.content.clone()
            };
            context.push_str(&format!("[{}]\n{}\n\n", entry.id, preview));
        }
        Ok(Some(context))
    }

    fn dir_for_scope(&self, scope: &MemoryScope) -> PathBuf {
        match scope {
            MemoryScope::Project => self.project_dir.clone(),
            MemoryScope::User => self.user_dir.clone(),
        }
    }
}

/// Sanitize a memory ID to be filesystem-safe.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .chars()
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_sanitize_id() {
        assert_eq!(sanitize_id("hello world"), "hello_world");
        assert_eq!(sanitize_id("foo/bar.baz"), "foo_bar_baz");
        assert_eq!(sanitize_id("a-b_c"), "a-b_c");
    }

    #[test]
    fn test_memory_crud() {
        let tmp = env::temp_dir().join("octocode_memory_test");
        let _ = fs::remove_dir_all(&tmp);
        let ws = tmp.join("workspace");
        let cfg = tmp.join("config");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&cfg).unwrap();

        let store = MemoryStore::new(ws.to_str().unwrap(), &cfg);

        // Create
        store.save(MemoryScope::Project, "test-note", "hello world").unwrap();

        // Read
        let entry = store.read(MemoryScope::Project, "test-note").unwrap().unwrap();
        assert_eq!(entry.content, "hello world");

        // List
        let list = store.list(MemoryScope::Project).unwrap();
        assert_eq!(list.len(), 1);

        // Search
        let results = store.search("hello").unwrap();
        assert_eq!(results.len(), 1);

        // Delete
        assert!(store.delete(MemoryScope::Project, "test-note").unwrap());
        assert!(store.read(MemoryScope::Project, "test-note").unwrap().is_none());

        let _ = fs::remove_dir_all(&tmp);
    }
}
