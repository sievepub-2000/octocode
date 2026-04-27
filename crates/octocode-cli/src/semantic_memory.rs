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

#[derive(Debug, Clone)]
pub struct RankedMemoryHit {
    pub term: String,
    pub record: String,
    pub score: i32,
    pub reasons: Vec<String>,
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
    Ok(query_ranked_semantic_memory(data_home, query)?
        .into_iter()
        .map(|hit| MemoryHit { term: hit.term, record: hit.record })
        .collect())
}

pub fn query_ranked_semantic_memory(data_home: &str, query: &str) -> std::io::Result<Vec<RankedMemoryHit>> {
    let agent_dir = PathBuf::from(data_home).join("agent");
    let index_path = agent_dir.join(MEMORY_INDEX_FILE);
    if !index_path.is_file() {
        rebuild_semantic_memory_index(data_home)?;
    }
    let query_terms = extract_terms(query);
    let raw = fs::read_to_string(index_path).unwrap_or_default();
    let mut hits = Vec::new();
    for (line_index, line) in raw.lines().enumerate() {
        let Some((term, records)) = line.split_once('\t') else { continue; };
        let term_match = query_terms.contains(term);
        let fuzzy_match = query_terms.iter().any(|q| term.contains(q) || q.contains(term));
        if term_match || fuzzy_match {
            for (record_index, record) in records.split(" || ").take(4).enumerate() {
                hits.push(score_hit(term, record, &query_terms, term_match, fuzzy_match, line_index, record_index));
            }
        }
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.term.cmp(&b.term)));
    hits.dedup_by(|a, b| a.term == b.term && a.record == b.record);
    hits.truncate(MAX_QUERY_RESULTS);
    Ok(hits)
}

fn score_hit(
    term: &str,
    record: &str,
    query_terms: &BTreeSet<String>,
    term_match: bool,
    fuzzy_match: bool,
    line_index: usize,
    record_index: usize,
) -> RankedMemoryHit {
    let mut score = 0;
    let mut reasons = Vec::new();
    if term_match {
        score += 100;
        reasons.push(String::from("exact-term"));
    }
    if fuzzy_match {
        score += 55;
        reasons.push(String::from("fuzzy-term"));
    }
    let record_lower = record.to_ascii_lowercase();
    for query_term in query_terms {
        if record_lower.contains(query_term) {
            score += 15;
        }
    }
    if record_lower.contains("\"ok\":true") || record_lower.contains("success") || record_lower.contains("done") {
        score += 12;
        reasons.push(String::from("successful-memory"));
    }
    if record_lower.contains("failed") || record_lower.contains("error") {
        score += 8;
        reasons.push(String::from("failure-learning"));
    }
    if record_lower.contains("file=") || record_lower.contains("file-memory") {
        score += 10;
        reasons.push(String::from("file-memory"));
    }
    score -= (line_index.min(30) as i32) / 3;
    score -= record_index as i32;
    RankedMemoryHit {
        term: term.to_string(),
        record: record.to_string(),
        score,
        reasons,
    }
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
    use super::{extract_terms, score_hit};
    use std::collections::BTreeSet;

    #[test]
    fn extracts_stable_terms() {
        let terms = extract_terms("RuntimeProviderRouter search-text agent reflection");
        assert!(terms.contains("runtimeproviderrouter"));
        assert!(terms.contains("search-text"));
        assert!(!terms.contains("agent"));
    }

    #[test]
    fn exact_successful_file_memory_scores_high() {
        let terms = BTreeSet::from([String::from("router")]);
        let hit = score_hit("router", "file=README router done", &terms, true, true, 0, 0);
        assert!(hit.score >= 120);
    }
}
