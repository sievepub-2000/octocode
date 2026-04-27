use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MEMORY_INDEX_FILE: &str = "semantic-memory-index.tsv";
const MAX_INDEX_TERMS: usize = 256;
const MAX_RECORDS_PER_TERM: usize = 12;
const MAX_QUERY_RESULTS: usize = 8;

#[derive(Debug, Clone)]
pub struct MemoryHit {
    pub term: String,
    pub record: String,
}

pub fn rebuild_semantic_memory_index(data_home: &str) -> std::io::Result<()> {
    let agent_dir = PathBuf::from(data_home).join("agent");
    fs::create_dir_all(&agent_dir)?;
    let memory_path = agent_dir.join("agent-memory.jsonl");
    let file_memory_path = agent_dir.join("file-memory.jsonl");
    let mut index: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for path in [&memory_path, &file_memory_path] {
        let raw = fs::read_to_string(path).unwrap_or_default();
        for line in raw.lines().rev().take(120) {
            for term in extract_terms(line).into_iter().take(24) {
                let records = index.entry(term).or_default();
                if records.len() < MAX_RECORDS_PER_TERM {
                    records.push(clip(line, 700));
                }
            }
        }
    }

    let mut rows = Vec::new();
    for (term, records) in index.into_iter().take(MAX_INDEX_TERMS) {
        rows.push(format!("{}\t{}", term, records.join(" || ").replace('\n', " ")));
    }
    atomic_replace(&agent_dir.join(MEMORY_INDEX_FILE), &format!("{}\n", rows.join("\n")))
}

pub fn query_semantic_memory(data_home: &str, query: &str) -> std::io::Result<Vec<MemoryHit>> {
    let agent_dir = PathBuf::from(data_home).join("agent");
    let index_path = agent_dir.join(MEMORY_INDEX_FILE);
    if !index_path.is_file() {
        rebuild_semantic_memory_index(data_home)?;
    }
    let query_terms = extract_terms(query);
    let raw = fs::read_to_string(index_path).unwrap_or_default();
    let mut hits = Vec::new();
    for line in raw.lines() {
        let Some((term, records)) = line.split_once('\t') else { continue; };
        if query_terms.contains(term) || query_terms.iter().any(|q| term.contains(q) || q.contains(term)) {
            for record in records.split(" || ").take(3) {
                hits.push(MemoryHit {
                    term: term.to_string(),
                    record: record.to_string(),
                });
                if hits.len() >= MAX_QUERY_RESULTS {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

fn extract_terms(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for token in text
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
        .map(str::trim)
        .filter(|t| t.len() >= 3 && t.len() <= 48)
    {
        let token = token.to_ascii_lowercase();
        if is_stop_word(&token) {
            continue;
        }
        out.insert(token);
        if out.len() >= 64 {
            break;
        }
    }
    out
}

fn is_stop_word(token: &str) -> bool {
    matches!(
        token,
        "the" | "and" | "for" | "with" | "this" | "that" | "from" | "true" | "false" | "null" | "session" | "goal" | "tool" | "agent" | "reflection"
    )
}

fn clip(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = value.chars().take(max_chars).collect::<String>();
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
    use super::extract_terms;

    #[test]
    fn extracts_stable_terms() {
        let terms = extract_terms("RuntimeProviderRouter search-text agent reflection");
        assert!(terms.contains("runtimeproviderrouter"));
        assert!(terms.contains("search-text"));
        assert!(!terms.contains("agent"));
    }
}
