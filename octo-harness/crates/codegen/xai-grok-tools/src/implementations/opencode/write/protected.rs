//! Overwrite guard for protected JSON files (evaluation answer files).
//!
//! In a benchmark run the agent once failed to read `answers.json` (wrong
//! relative path), rewrote the whole file from memory, and silently dropped two
//! answers it had already written. A workspace can list files whose top-level
//! JSON keys must survive every overwrite in `.octocode/protected-files.json`:
//!
//! ```json
//! { "preserve_json_keys": ["bench/**/answers.json", "bench/arc-agi-2/answers/*.json"] }
//! ```
//!
//! Patterns are relative to the directory that holds `.octocode/`.

use std::path::{Path, PathBuf};

const MANIFEST: &str = ".octocode/protected-files.json";
const SEARCH_DEPTH: usize = 8;

#[derive(serde::Deserialize, Default)]
struct Manifest {
    #[serde(default)]
    preserve_json_keys: Vec<String>,
}

/// The workspace root that declares `path` protected, if any.
fn protecting_root(path: &Path) -> Option<PathBuf> {
    for root in path.ancestors().skip(1).take(SEARCH_DEPTH) {
        let manifest = root.join(MANIFEST);
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        let manifest: Manifest = serde_json::from_str(&text).unwrap_or_default();
        let relative = path.strip_prefix(root).ok()?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        let mut builder = globset::GlobSetBuilder::new();
        for pattern in &manifest.preserve_json_keys {
            if let Ok(glob) = globset::Glob::new(pattern) {
                builder.add(glob);
            }
        }
        let set = builder.build().ok()?;
        return set.is_match(&relative).then(|| root.to_path_buf());
    }
    None
}

/// `Some(reason)` when overwriting `path` with `new_content` must be refused.
pub(super) fn refuse_overwrite(
    path: &Path,
    old_content: Option<&str>,
    new_content: &str,
) -> Option<String> {
    let old_content = old_content?;
    protecting_root(path)?;
    let Ok(serde_json::Value::Object(old)) = serde_json::from_str::<serde_json::Value>(old_content)
    else {
        return None; // The existing file is not a JSON object; nothing to preserve.
    };
    let new = match serde_json::from_str::<serde_json::Value>(new_content) {
        Ok(serde_json::Value::Object(new)) => new,
        _ => {
            return Some(format!(
                "Refused to overwrite protected file {}: the new content is not a JSON object. \
                 Read the file, merge your change into it, and write the merged object.",
                path.display()
            ));
        }
    };
    let lost: Vec<&str> = old
        .keys()
        .filter(|key| !new.contains_key(*key))
        .map(String::as_str)
        .collect();
    if lost.is_empty() {
        return None;
    }
    Some(format!(
        "Refused to overwrite protected file {}: it would drop existing entries {:?}. \
         Read the file first, merge your change into the existing object, and write the merged result.",
        path.display(),
        lost
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join(".octocode")).unwrap();
        std::fs::write(
            root.join(MANIFEST),
            r#"{"preserve_json_keys": ["bench/**/answers.json"]}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("bench/simpleqa")).unwrap();
        (tmp, root)
    }

    #[test]
    fn dropping_an_existing_answer_is_refused() {
        let (_tmp, root) = workspace();
        let path = root.join("bench/simpleqa/answers.json");
        let old = r#"{"q-09": {"answer": "a"}, "q-10": {"answer": "b"}}"#;
        let reason = refuse_overwrite(
            &path,
            Some(old),
            r#"{"q-10": {"answer": "b"}, "q-11": {"answer": "c"}}"#,
        );
        assert!(reason.unwrap().contains("q-09"));
    }

    #[test]
    fn merged_writes_and_new_files_pass() {
        let (_tmp, root) = workspace();
        let path = root.join("bench/simpleqa/answers.json");
        let old = r#"{"q-09": {"answer": "a"}}"#;
        assert!(
            refuse_overwrite(
                &path,
                Some(old),
                r#"{"q-09": {"answer": "z"}, "q-10": {"answer": "b"}}"#
            )
            .is_none()
        );
        assert!(refuse_overwrite(&path, None, "{}").is_none());
    }

    #[test]
    fn broken_json_over_a_protected_file_is_refused() {
        let (_tmp, root) = workspace();
        let path = root.join("bench/simpleqa/answers.json");
        assert!(refuse_overwrite(&path, Some(r#"{"q": 1}"#), "not json").is_some());
    }

    #[test]
    fn unprotected_files_are_untouched() {
        let (_tmp, root) = workspace();
        let path = root.join("bench/notes.json");
        assert!(refuse_overwrite(&path, Some(r#"{"a": 1}"#), "{}").is_none());
    }
}
