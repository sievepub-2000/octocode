use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_MEMORY_LINES: usize = 120;
pub const MAX_TASK_TREE_LINES: usize = 80;
pub const MAX_AUDIT_LINES: usize = 500;
pub const MAX_AGENT_TEMP_FILES: usize = 8;
pub const MAX_LINE_BYTES: usize = 4096;

#[derive(Debug, Clone)]
pub struct ResourceBudget {
    pub max_memory_lines: usize,
    pub max_task_tree_lines: usize,
    pub max_audit_lines: usize,
    pub max_agent_temp_files: usize,
    pub max_line_bytes: usize,
}

impl Default for ResourceBudget {
    fn default() -> Self {
        Self {
            max_memory_lines: MAX_MEMORY_LINES,
            max_task_tree_lines: MAX_TASK_TREE_LINES,
            max_audit_lines: MAX_AUDIT_LINES,
            max_agent_temp_files: MAX_AGENT_TEMP_FILES,
            max_line_bytes: MAX_LINE_BYTES,
        }
    }
}

pub fn enforce_agent_resource_budget(data_home: &str) -> std::io::Result<()> {
    let budget = ResourceBudget::default();
    let root = PathBuf::from(data_home);
    let agent_dir = root.join("agent");
    let audit_dir = root.join("audit");
    fs::create_dir_all(&agent_dir)?;
    fs::create_dir_all(&audit_dir)?;

    compact_jsonl_file(&agent_dir.join("agent-memory.jsonl"), budget.max_memory_lines, budget.max_line_bytes)?;
    compact_jsonl_file(&agent_dir.join("agent-task-trees.jsonl"), budget.max_task_tree_lines, budget.max_line_bytes)?;
    compact_jsonl_file(&audit_dir.join("high-permission.log"), budget.max_audit_lines, budget.max_line_bytes)?;
    cleanup_temp_files(&agent_dir, budget.max_agent_temp_files)?;
    Ok(())
}

pub fn compact_jsonl_file(path: &Path, max_lines: usize, max_line_bytes: usize) -> std::io::Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(path)?;
    let mut lines = raw
        .lines()
        .rev()
        .take(max_lines)
        .map(|line| truncate_line(line, max_line_bytes))
        .collect::<Vec<_>>();
    lines.reverse();
    let compacted = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    atomic_replace(path, &compacted)
}

pub fn cleanup_temp_files(dir: &Path, max_files: usize) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut temp_files = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("tmp-")
        })
        .filter_map(|entry| {
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    temp_files.sort_by_key(|(modified, _)| *modified);
    let overflow = temp_files.len().saturating_sub(max_files);
    for (_, path) in temp_files.into_iter().take(overflow) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn truncate_line(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let mut out = String::new();
    for ch in line.chars() {
        if out.len() + ch.len_utf8() > max_bytes.saturating_sub(16) {
            break;
        }
        out.push(ch);
    }
    out.push_str("...[truncated]");
    out
}

fn atomic_replace(path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::truncate_line;

    #[test]
    fn truncate_line_caps_large_content() {
        let line = "x".repeat(5000);
        let clipped = truncate_line(&line, 128);
        assert!(clipped.len() <= 128);
        assert!(clipped.ends_with("...[truncated]"));
    }
}
