use std::fs;
use std::path::{Path, PathBuf};

const CONTINUATION_FILE: &str = "continuations.jsonl";
const FILE_MEMORY_FILE: &str = "file-memory.jsonl";
const MAX_FILE_MEMORIES: usize = 24;
const MAX_CONTINUATION_LINES: usize = 48;
const MAX_FILE_BYTES: usize = 8192;
const MAX_SNIPPET_CHARS: usize = 900;

#[derive(Debug, Clone, Default)]
pub struct ContinuationContext {
    pub session_summary: Option<String>,
    pub file_memories: Vec<String>,
}

pub fn prepare_continuation_context(
    data_home: &str,
    workspace_root: &str,
    session_id: &str,
    goal: &str,
) -> std::io::Result<ContinuationContext> {
    let agent_dir = PathBuf::from(data_home).join("agent");
    fs::create_dir_all(&agent_dir)?;
    let summary = latest_session_continuation(&agent_dir, session_id)?;
    let file_memories = extract_file_memories(Path::new(workspace_root), MAX_FILE_MEMORIES)?;
    persist_file_memories(&agent_dir, session_id, goal, &file_memories)?;
    Ok(ContinuationContext {
        session_summary: summary,
        file_memories,
    })
}

pub fn augment_goal_with_continuation(goal: &str, context: &ContinuationContext) -> String {
    let mut parts = vec![goal.trim().to_string()];
    if let Some(summary) = &context.session_summary {
        parts.push(format!("\n[continuation-summary]\n{}", summary));
    }
    if !context.file_memories.is_empty() {
        parts.push(format!(
            "\n[file-memory]\n{}",
            context.file_memories.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
        ));
    }
    parts.join("\n")
}

pub fn save_continuation_summary(
    data_home: &str,
    session_id: &str,
    goal: &str,
    summary: &str,
) -> std::io::Result<()> {
    let agent_dir = PathBuf::from(data_home).join("agent");
    fs::create_dir_all(&agent_dir)?;
    let path = agent_dir.join(CONTINUATION_FILE);
    let line = format!(
        "{{\"session\":\"{}\",\"goal\":\"{}\",\"summary\":\"{}\"}}\n",
        escape_json(session_id),
        escape_json(goal),
        escape_json(&clip(summary, 1600))
    );
    append_line_bounded(&path, &line, MAX_CONTINUATION_LINES)
}

fn latest_session_continuation(agent_dir: &Path, session_id: &str) -> std::io::Result<Option<String>> {
    let path = agent_dir.join(CONTINUATION_FILE);
    let raw = fs::read_to_string(path).unwrap_or_default();
    for line in raw.lines().rev() {
        if line.contains(&format!("\"session\":\"{}\"", escape_json(session_id))) {
            return Ok(extract_json_field(line, "summary"));
        }
    }
    Ok(None)
}

fn extract_file_memories(workspace_root: &Path, max_items: usize) -> std::io::Result<Vec<String>> {
    let candidates = [
        "CLAUDE.md",
        "AGENTS.md",
        "README.md",
        "Cargo.toml",
        "package.json",
        "pyproject.toml",
        "docs/current-implementation-status.md",
    ];
    let mut memories = Vec::new();
    for relative in candidates {
        if memories.len() >= max_items {
            break;
        }
        let path = workspace_root.join(relative);
        if !path.is_file() {
            continue;
        }
        let meta = fs::metadata(&path)?;
        if meta.len() > MAX_FILE_BYTES as u64 {
            let content = fs::read_to_string(&path).unwrap_or_default();
            memories.push(format!(
                "file={} bytes={} head={}",
                relative,
                meta.len(),
                clip(&content, MAX_SNIPPET_CHARS)
            ));
        } else {
            let content = fs::read_to_string(&path).unwrap_or_default();
            memories.push(format!("file={} content={}", relative, clip(&content, MAX_SNIPPET_CHARS)));
        }
    }
    Ok(memories)
}

fn persist_file_memories(
    agent_dir: &Path,
    session_id: &str,
    goal: &str,
    memories: &[String],
) -> std::io::Result<()> {
    let path = agent_dir.join(FILE_MEMORY_FILE);
    for memory in memories.iter().take(MAX_FILE_MEMORIES) {
        let line = format!(
            "{{\"session\":\"{}\",\"goal\":\"{}\",\"memory\":\"{}\"}}\n",
            escape_json(session_id),
            escape_json(goal),
            escape_json(memory)
        );
        append_line_bounded(&path, &line, MAX_FILE_MEMORIES)?;
    }
    Ok(())
}

fn append_line_bounded(path: &Path, line: &str, max_lines: usize) -> std::io::Result<()> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut lines = raw.lines().map(String::from).collect::<Vec<_>>();
    lines.push(line.trim_end().to_string());
    if lines.len() > max_lines {
        lines = lines[lines.len() - max_lines..].to_vec();
    }
    let body = if lines.is_empty() { String::new() } else { format!("{}\n", lines.join("\n")) };
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body)?;
    fs::rename(tmp, path)
}

fn extract_json_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = line.find(&needle)? + needle.len();
    let mut out = String::new();
    let mut escaped = false;
    for ch in line[start..].chars() {
        if escaped {
            out.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '"' => '"',
                other => other,
            });
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(out),
            other => out.push(other),
        }
    }
    None
}

fn clip(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.replace('\n', "\\n");
    }
    let mut out = value.chars().take(max_chars).collect::<String>();
    out.push_str("...[truncated]");
    out.replace('\n', "\\n")
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

#[cfg(test)]
mod tests {
    use super::augment_goal_with_continuation;
    use super::ContinuationContext;

    #[test]
    fn augments_goal_with_summary_and_file_memory() {
        let context = ContinuationContext {
            session_summary: Some(String::from("previous state")),
            file_memories: vec![String::from("README facts")],
        };
        let out = augment_goal_with_continuation("continue", &context);
        assert!(out.contains("previous state"));
        assert!(out.contains("README facts"));
    }
}
