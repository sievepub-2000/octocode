//! Skills Hub — render a Markdown index of `skills/auto/<slug>/` so
//! the recorded-skill catalog is browsable on a static site (e.g.
//! GitHub Pages). The renderer is pure: it reads the file system and
//! produces a string, the caller decides where to write it.

use std::fs;
use std::path::Path;

use octocode_core::OctoError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub slug: String,
    pub score: i64,
    pub summary: String,
}

/// Walk `<workspace_root>/skills/auto/` and collect skill metadata.
/// `summary` is the first non-empty line of `SKILL.md` (heading lines
/// stripped of leading `#`); when no SKILL.md exists, `summary` is
/// empty. Entries are sorted by score descending, then slug ascending,
/// matching the ordering of `skill-list`.
pub fn collect_skills(workspace_root: &Path) -> Result<Vec<SkillEntry>, OctoError> {
    let auto_dir = workspace_root.join("skills").join("auto");
    if !auto_dir.exists() {
        return Ok(Vec::new());
    }
    let read = fs::read_dir(&auto_dir)
        .map_err(|e| OctoError::Runtime(format!("read {}: {e}", auto_dir.display())))?;
    let mut entries: Vec<SkillEntry> = Vec::new();
    for entry in read.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().into_owned();
        let score: i64 = fs::read_to_string(entry.path().join("score.txt"))
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let summary = fs::read_to_string(entry.path().join("SKILL.md"))
            .ok()
            .and_then(|content| first_summary_line(&content))
            .unwrap_or_default();
        entries.push(SkillEntry { slug, score, summary });
    }
    entries.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.slug.cmp(&b.slug)));
    Ok(entries)
}

fn first_summary_line(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let stripped = trimmed.trim_start_matches('#').trim().to_string();
        if stripped.is_empty() {
            continue;
        }
        return Some(stripped);
    }
    None
}

/// Render the Markdown body for `docs/skills-hub/index.md`. Pure fn so
/// it can be unit-tested without touching the file system.
pub fn render_index(entries: &[SkillEntry]) -> String {
    let mut out = String::new();
    out.push_str("# Octocode Skills Hub\n\n");
    out.push_str(
        "Auto-recorded skills, ranked by accumulated `+1` / `-1` score. Updated by the runtime.\n\n",
    );
    if entries.is_empty() {
        out.push_str("_No skills recorded yet._\n");
        return out;
    }
    out.push_str("| Skill | Score | Summary |\n|---|---:|---|\n");
    for entry in entries {
        let summary = if entry.summary.is_empty() {
            "_no summary_".to_string()
        } else {
            entry.summary.replace('|', "\\|")
        };
        out.push_str(&format!(
            "| `{}` | {} | {} |\n",
            entry.slug, entry.score, summary
        ));
    }
    out
}

/// Convenience: collect + render + write to
/// `<workspace_root>/docs/skills-hub/index.md`. Returns the number of
/// entries rendered.
pub fn render_to_workspace(workspace_root: &Path) -> Result<usize, OctoError> {
    let entries = collect_skills(workspace_root)?;
    let body = render_index(&entries);
    let out_dir = workspace_root.join("docs").join("skills-hub");
    fs::create_dir_all(&out_dir)
        .map_err(|e| OctoError::Runtime(format!("create {}: {e}", out_dir.display())))?;
    let out_path = out_dir.join("index.md");
    fs::write(&out_path, body)
        .map_err(|e| OctoError::Runtime(format!("write {}: {e}", out_path.display())))?;
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "octocode-skills-hub-{}-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            N.fetch_add(1, Ordering::SeqCst),
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn collect_returns_empty_when_no_skills_dir() {
        let root = temp_root("none");
        let entries = collect_skills(&root).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn collect_orders_by_score_desc_then_slug_asc() {
        let root = temp_root("order");
        for (slug, score, summary) in [
            ("alpha", 2, "# Alpha skill\nbody"),
            ("bravo", 5, "Bravo summary line\n"),
            ("charlie", 2, "# Charlie\n"),
        ] {
            let dir = root.join("skills").join("auto").join(slug);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), summary).unwrap();
            fs::write(dir.join("score.txt"), score.to_string()).unwrap();
        }
        let entries = collect_skills(&root).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].slug, "bravo");
        assert_eq!(entries[1].slug, "alpha");
        assert_eq!(entries[2].slug, "charlie");
        assert_eq!(entries[0].summary, "Bravo summary line");
        assert_eq!(entries[1].summary, "Alpha skill");
    }

    #[test]
    fn render_writes_table_and_pipes_are_escaped() {
        let body = render_index(&[
            SkillEntry { slug: String::from("a"), score: 1, summary: String::from("uses a|b form") },
        ]);
        assert!(body.contains("# Octocode Skills Hub"));
        assert!(body.contains("| `a` | 1 | uses a\\|b form |"));
    }

    #[test]
    fn render_to_workspace_writes_index_md() {
        let root = temp_root("write");
        let dir = root.join("skills").join("auto").join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "# Demo skill\n").unwrap();
        fs::write(dir.join("score.txt"), "3").unwrap();
        let n = render_to_workspace(&root).unwrap();
        assert_eq!(n, 1);
        let body =
            fs::read_to_string(root.join("docs").join("skills-hub").join("index.md")).unwrap();
        assert!(body.contains("`demo`"));
        assert!(body.contains("| 3 |"));
    }
}
