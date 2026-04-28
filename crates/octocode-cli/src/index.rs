//! P9-A: Lightweight code index scaffold.
//!
//! Provides three CLI subcommands:
//! * `index build` — walk the workspace and build a token-based inverted
//!   index persisted at `.octocode/index.json`.
//! * `index query <terms...>` — load the index and return the top files
//!   ranked by token-overlap score.
//! * `index status` — emit metadata about the stored index.
//!
//! This is intentionally dependency-light (no tree-sitter / no sqlite-vec
//! yet): it establishes the CLI surface, the on-disk schema, and the
//! scoring model so later phases can swap in richer backends without
//! breaking the `index` contract.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// On-disk schema version. Bump when the format changes incompatibly.
pub const INDEX_SCHEMA_VERSION: u32 = 1;

/// Default relative path inside the workspace for the index artifact.
pub const DEFAULT_INDEX_PATH: &str = ".octocode/index.json";

/// Files with these extensions are considered source and indexed.
/// Kept conservative; can be widened later.
pub const INDEXED_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt",
    "c", "cc", "cpp", "cxx", "h", "hpp", "hh", "cs", "rb", "php", "swift",
    "scala", "sh", "ps1", "psm1", "md", "toml", "yaml", "yml", "json",
    "html", "css", "scss",
];

/// Directory names that are always skipped.
pub const SKIP_DIRS: &[&str] = &[
    ".git", ".octocode", "node_modules", "target", "dist", "build", "out",
    ".next", ".nuxt", ".cache", ".tmp", "tmp", ".venv", "venv", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vs", ".vscode",
];

/// Per-file record after tokenization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFile {
    /// Path relative to the workspace root (forward slashes).
    pub path: String,
    /// Size in bytes at index time.
    pub bytes: u64,
    /// Number of tokens extracted.
    pub token_count: u32,
}

/// Top-level index artifact persisted as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexArtifact {
    pub schema_version: u32,
    pub workspace_root: String,
    /// Seconds since UNIX_EPOCH when `index build` ran.
    pub built_at_unix: u64,
    pub files: Vec<IndexedFile>,
    /// Inverted index: token -> sorted list of file indices into `files`.
    pub tokens: BTreeMap<String, Vec<u32>>,
}

impl IndexArtifact {
    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn unique_token_count(&self) -> usize {
        self.tokens.len()
    }
}

/// Tokenize a UTF-8 text payload. Yields lowercase ASCII-ish tokens of
/// length `>= 2`, split on anything that is not an ASCII alnum or '_'.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            for c in ch.to_lowercase() {
                current.push(c);
            }
        } else if !current.is_empty() {
            if current.len() >= 2 {
                out.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 2 {
        out.push(current);
    }
    out
}

fn is_indexable(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => INDEXED_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.starts_with('.')
}

fn walk_collect(root: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let entries = fs::read_dir(root)?;
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if ft.is_dir() {
            if should_skip_dir(&name_str) {
                continue;
            }
            walk_collect(&entry.path(), out)?;
        } else if ft.is_file() {
            let p = entry.path();
            if is_indexable(&p) {
                out.push(p);
            }
        }
    }
    Ok(())
}

fn read_text_limited(path: &Path, max_bytes: u64) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let meta = f.metadata().ok()?;
    if meta.len() > max_bytes {
        return None; // skip huge files
    }
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// Build an index over `root` and return the artifact (no I/O).
pub fn build_index(root: &Path) -> std::io::Result<IndexArtifact> {
    let mut files = Vec::new();
    walk_collect(root, &mut files)?;
    files.sort();

    let mut out_files: Vec<IndexedFile> = Vec::with_capacity(files.len());
    let mut tokens: BTreeMap<String, Vec<u32>> = BTreeMap::new();

    for (idx, path) in files.iter().enumerate() {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let Some(text) = read_text_limited(path, 512 * 1024) else {
            continue;
        };
        let toks = tokenize(&text);
        let bytes = text.len() as u64;
        let token_count = toks.len() as u32;
        // Deduplicate tokens per file for inverted posting.
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for t in toks {
            if seen.insert(t.clone()) {
                tokens.entry(t).or_default().push(idx as u32);
            }
        }
        out_files.push(IndexedFile {
            path: rel,
            bytes,
            token_count,
        });
    }

    // Shrink: sort postings (already in-order because we push by idx ascending,
    // but be defensive) and dedup.
    for postings in tokens.values_mut() {
        postings.sort_unstable();
        postings.dedup();
    }

    let built_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(IndexArtifact {
        schema_version: INDEX_SCHEMA_VERSION,
        workspace_root: root.to_string_lossy().to_string(),
        built_at_unix,
        files: out_files,
        tokens,
    })
}

/// Persist an index artifact to `<root>/.octocode/index.json`.
pub fn persist_index(root: &Path, art: &IndexArtifact) -> std::io::Result<PathBuf> {
    let dir = root.join(".octocode");
    fs::create_dir_all(&dir)?;
    let path = dir.join("index.json");
    let mut f = fs::File::create(&path)?;
    let json = serde_json::to_string_pretty(art).expect("serialize IndexArtifact");
    f.write_all(json.as_bytes())?;
    Ok(path)
}

/// Load an index artifact from `<root>/.octocode/index.json`.
pub fn load_index(root: &Path) -> std::io::Result<IndexArtifact> {
    let path = root.join(DEFAULT_INDEX_PATH);
    let bytes = fs::read(&path)?;
    let art: IndexArtifact = serde_json::from_slice(&bytes).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("failed to parse index.json: {e}"),
        )
    })?;
    Ok(art)
}

/// Score and rank files for a set of query terms.
#[derive(Debug, Clone, Serialize)]
pub struct QueryHit {
    pub path: String,
    pub score: u32,
    pub matched: Vec<String>,
}

pub fn query(art: &IndexArtifact, terms: &[String], top_k: usize) -> Vec<QueryHit> {
    use std::collections::HashMap;
    let mut hits: HashMap<u32, (u32, Vec<String>)> = HashMap::new();
    for raw in terms {
        let norm = raw.to_lowercase();
        if norm.len() < 2 {
            continue;
        }
        if let Some(postings) = art.tokens.get(&norm) {
            for &idx in postings {
                let entry = hits.entry(idx).or_insert((0, Vec::new()));
                entry.0 += 1;
                if !entry.1.contains(&norm) {
                    entry.1.push(norm.clone());
                }
            }
        }
    }
    let mut ranked: Vec<(u32, u32, Vec<String>)> = hits
        .into_iter()
        .map(|(idx, (score, matched))| (idx, score, matched))
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked
        .into_iter()
        .take(top_k)
        .filter_map(|(idx, score, matched)| {
            art.files.get(idx as usize).map(|f| QueryHit {
                path: f.path.clone(),
                score,
                matched,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexStatus {
    pub schema_version: u32,
    pub present: bool,
    pub path: String,
    pub workspace_root: Option<String>,
    pub built_at_unix: Option<u64>,
    pub file_count: Option<usize>,
    pub unique_token_count: Option<usize>,
}

pub fn status(root: &Path) -> IndexStatus {
    let path = root.join(DEFAULT_INDEX_PATH);
    let path_str = path.to_string_lossy().to_string();
    match load_index(root) {
        Ok(art) => IndexStatus {
            schema_version: art.schema_version,
            present: true,
            path: path_str,
            workspace_root: Some(art.workspace_root.clone()),
            built_at_unix: Some(art.built_at_unix),
            file_count: Some(art.file_count()),
            unique_token_count: Some(art.unique_token_count()),
        },
        Err(_) => IndexStatus {
            schema_version: INDEX_SCHEMA_VERSION,
            present: false,
            path: path_str,
            workspace_root: None,
            built_at_unix: None,
            file_count: None,
            unique_token_count: None,
        },
    }
}

/// Dispatch `index <subcommand> ...` parsed from CLI args.
///
/// Returns the JSON output to print. Errors are surfaced up as `Err`.
pub fn dispatch(root: &Path, args: &[String]) -> Result<String, Box<dyn std::error::Error>> {
    let sub = args.first().map(String::as_str).unwrap_or("help");
    match sub {
        "build" => {
            let art = build_index(root)?;
            let written = persist_index(root, &art)?;
            let summary = serde_json::json!({
                "ok": true,
                "path": written.to_string_lossy(),
                "schema_version": art.schema_version,
                "file_count": art.file_count(),
                "unique_token_count": art.unique_token_count(),
                "built_at_unix": art.built_at_unix,
            });
            Ok(serde_json::to_string_pretty(&summary)?)
        }
        "query" => {
            if args.len() < 2 {
                return Err("usage: octocode-cli index query <term> [<term>...] [--top N]".into());
            }
            // Allow --top N anywhere after the subcommand.
            let mut top_k: usize = 10;
            let mut terms: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--top" | "-n" => {
                        let n: usize = args
                            .get(i + 1)
                            .ok_or("missing value after --top")?
                            .parse()
                            .map_err(|e| format!("invalid --top value: {e}"))?;
                        top_k = n.max(1);
                        i += 2;
                    }
                    other => {
                        terms.push(other.to_string());
                        i += 1;
                    }
                }
            }
            if terms.is_empty() {
                return Err("at least one query term required".into());
            }
            let art = load_index(root).map_err(|e| {
                format!("no index found (run `octocode-cli index build` first): {e}")
            })?;
            let hits = query(&art, &terms, top_k);
            let summary = serde_json::json!({
                "ok": true,
                "terms": terms,
                "top_k": top_k,
                "hit_count": hits.len(),
                "hits": hits,
            });
            Ok(serde_json::to_string_pretty(&summary)?)
        }
        "status" => {
            let s = status(root);
            Ok(serde_json::to_string_pretty(&s)?)
        }
        "help" | "--help" | "-h" | "" => Ok(String::from(
            "octocode-cli index <subcommand>\n\n\
             subcommands:\n  \
               build                     walk the workspace and persist a token index\n  \
               query <term> [--top N]    rank files by matching tokens (default N=10)\n  \
               status                    emit index metadata as JSON\n",
        )),
        other => Err(format!(
            "unknown `index` subcommand '{other}'. try: build | query | status"
        )
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_workspace() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "octocode-index-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn tokenize_splits_on_punctuation_and_lowercases() {
        let toks = tokenize("Fn main() { let x_y = Foo::Bar; } // hello_world");
        // "fn", "main", "let", "x_y", "foo", "bar", "hello_world"
        assert!(toks.contains(&"main".to_string()));
        assert!(toks.contains(&"x_y".to_string()));
        assert!(toks.contains(&"foo".to_string()));
        assert!(toks.contains(&"hello_world".to_string()));
        // single-char tokens like "x" after split on '=' should be dropped
        assert!(!toks.contains(&"a".to_string()));
    }

    #[test]
    fn tokenize_drops_short_tokens() {
        let toks = tokenize("a b ab cd");
        assert_eq!(toks, vec!["ab".to_string(), "cd".to_string()]);
    }

    #[test]
    fn build_index_walks_workspace_and_skips_target_dir() {
        let root = tmp_workspace();
        write_file(&root, "src/lib.rs", "pub fn alpha_beta() {}");
        write_file(&root, "src/sub/mod.rs", "pub const GAMMA_DELTA: u32 = 1;");
        write_file(&root, "target/junk.rs", "pub fn should_be_skipped() {}");
        write_file(&root, "node_modules/pkg/index.js", "function hidden() {}");
        write_file(&root, "README.md", "# Title\n\ntext body here");

        let art = build_index(&root).unwrap();
        let paths: Vec<&str> = art.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.ends_with("src/lib.rs")));
        assert!(paths.iter().any(|p| p.ends_with("src/sub/mod.rs")));
        assert!(paths.contains(&"README.md"));
        assert!(
            !paths.iter().any(|p| p.contains("target/")),
            "target/ dir should be skipped, got: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "node_modules should be skipped, got: {paths:?}"
        );

        // alpha_beta is present in lib.rs only.
        let postings = art.tokens.get("alpha_beta").expect("token missing");
        assert_eq!(postings.len(), 1);

        // gamma_delta is present in mod.rs only.
        let postings2 = art.tokens.get("gamma_delta").expect("token missing");
        assert_eq!(postings2.len(), 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn persist_and_load_roundtrip() {
        let root = tmp_workspace();
        write_file(&root, "a.rs", "pub fn zeta_omega() {}");
        let art = build_index(&root).unwrap();
        let path = persist_index(&root, &art).unwrap();
        assert!(path.exists());
        let loaded = load_index(&root).unwrap();
        assert_eq!(loaded.schema_version, INDEX_SCHEMA_VERSION);
        assert_eq!(loaded.file_count(), art.file_count());
        assert!(loaded.tokens.contains_key("zeta_omega"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn query_ranks_by_token_overlap() {
        let root = tmp_workspace();
        write_file(&root, "a.rs", "alpha alpha beta");
        write_file(&root, "b.rs", "alpha gamma");
        write_file(&root, "c.rs", "delta epsilon");
        let art = build_index(&root).unwrap();

        let hits = query(&art, &["alpha".to_string(), "beta".to_string()], 10);
        // a.rs matches both tokens, b.rs matches one, c.rs matches none.
        assert_eq!(hits.len(), 2);
        assert!(hits[0].path.ends_with("a.rs"));
        assert_eq!(hits[0].score, 2);
        assert!(hits[1].path.ends_with("b.rs"));
        assert_eq!(hits[1].score, 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn status_reports_absent_when_no_index() {
        let root = tmp_workspace();
        let s = status(&root);
        assert!(!s.present);
        assert!(s.file_count.is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn status_reports_present_after_build() {
        let root = tmp_workspace();
        write_file(&root, "a.rs", "pub fn hello() {}");
        let art = build_index(&root).unwrap();
        persist_index(&root, &art).unwrap();
        let s = status(&root);
        assert!(s.present);
        assert_eq!(s.file_count, Some(art.file_count()));
        assert_eq!(s.schema_version, INDEX_SCHEMA_VERSION);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dispatch_status_returns_json() {
        let root = tmp_workspace();
        let out = dispatch(&root, &["status".to_string()]).unwrap();
        assert!(out.contains("\"present\""));
        assert!(out.contains("\"schema_version\""));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dispatch_build_then_query() {
        let root = tmp_workspace();
        write_file(&root, "src/lib.rs", "pub fn needle_one() {}");
        write_file(&root, "src/other.rs", "pub fn haystack() {}");

        let build_out = dispatch(&root, &["build".to_string()]).unwrap();
        assert!(build_out.contains("\"ok\": true"));
        assert!(build_out.contains("\"file_count\": 2"));

        let query_out = dispatch(
            &root,
            &["query".to_string(), "needle_one".to_string()],
        )
        .unwrap();
        assert!(query_out.contains("needle_one"));
        assert!(query_out.contains("src/lib.rs"));
        assert!(!query_out.contains("src/other.rs"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dispatch_unknown_sub_errors() {
        let root = tmp_workspace();
        let err = dispatch(&root, &["bogus".to_string()]).unwrap_err();
        assert!(err.to_string().contains("unknown"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dispatch_help_mentions_all_subs() {
        let root = tmp_workspace();
        let out = dispatch(&root, &["help".to_string()]).unwrap();
        assert!(out.contains("build"));
        assert!(out.contains("query"));
        assert!(out.contains("status"));
        fs::remove_dir_all(&root).ok();
    }
}
