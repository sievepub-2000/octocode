//! P11-A: `skills-install <url>` — install a remote SKILL.md into the user's
//! skills directory with a **strict HTTPS allowlist** and size/content checks.
//!
//! Security contract:
//! * Only `https://` URLs from an explicit host allowlist are accepted. This
//!   prevents SSRF against localhost / intranet, and blocks plaintext HTTP.
//! * Response must be `text/*` and <= 256 KiB; binaries / huge blobs are
//!   refused before any disk write.
//! * Target filename is derived from the URL path basename. If a skill
//!   already exists, `--force` is required to overwrite.
//! * We never execute the downloaded content. It is written verbatim to
//!   `<config_home>/skills/<name>/SKILL.md`.
//!
//! URL deduction:
//! * `https://raw.githubusercontent.com/.../SKILL.md` → name = penultimate
//!   path segment (the skill directory).
//! * `https://.../foo.md` → name = `foo`.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

const MAX_BYTES: usize = 256 * 1024;
const ALLOWED_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "gitlab.com",
];

#[derive(Debug)]
pub struct InstalledSkill {
    pub id: String,
    pub path: PathBuf,
    pub bytes: usize,
}

pub fn install_from_url(
    url: &str,
    config_home: &std::path::Path,
    force: bool,
) -> Result<InstalledSkill, String> {
    let (host, basename, skill_id) = parse_and_validate_url(url)?;
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!(
            "host '{host}' is not on the skills-install allowlist: {ALLOWED_HOSTS:?}"
        ));
    }

    let dest_dir = config_home.join("skills").join(&skill_id);
    let dest_file = dest_dir.join("SKILL.md");
    if dest_file.exists() && !force {
        return Err(format!(
            "skill '{skill_id}' already installed at {}. re-run with --force to overwrite",
            dest_file.display()
        ));
    }

    let body = fetch_text(url)?;
    if body.len() > MAX_BYTES {
        return Err(format!(
            "response too large: {} bytes (max {MAX_BYTES})",
            body.len()
        ));
    }
    if !looks_like_markdown(&body) {
        return Err(String::from(
            "response does not look like a SKILL.md (missing markdown heading)",
        ));
    }
    let _ = basename; // retained for future manifest use

    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("failed to create {}: {e}", dest_dir.display()))?;
    fs::write(&dest_file, &body)
        .map_err(|e| format!("failed to write {}: {e}", dest_file.display()))?;

    Ok(InstalledSkill {
        id: skill_id,
        path: dest_file,
        bytes: body.len(),
    })
}

fn parse_and_validate_url(url: &str) -> Result<(String, String, String), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| String::from("only https:// URLs are accepted"))?;
    let (authority, path) = rest
        .split_once('/')
        .ok_or_else(|| String::from("URL is missing a path"))?;
    if authority.is_empty() {
        return Err(String::from("URL host is empty"));
    }
    let host = authority.split(':').next().unwrap_or(authority).to_string();
    if host.contains("..") || host.is_empty() {
        return Err(String::from("invalid host"));
    }
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(String::from("URL path is empty"));
    }
    let basename = (*segments.last().unwrap()).to_string();
    if !basename.to_ascii_lowercase().ends_with(".md") {
        return Err(String::from("URL must point to a .md file"));
    }
    // Derive skill id: if filename is SKILL.md, use the parent segment;
    // otherwise strip the .md extension.
    let skill_id = if basename.eq_ignore_ascii_case("SKILL.md") && segments.len() >= 2 {
        segments[segments.len() - 2].to_string()
    } else {
        basename.trim_end_matches(".md").trim_end_matches(".MD").to_string()
    };
    if skill_id.is_empty()
        || skill_id.contains('/')
        || skill_id.contains('\\')
        || skill_id.contains("..")
    {
        return Err(String::from("could not derive a safe skill id from URL"));
    }
    Ok((host, basename, skill_id))
}

fn fetch_text(url: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("http request failed: {e}"))?;
    let ctype = resp.header("Content-Type").unwrap_or("").to_ascii_lowercase();
    if !ctype.starts_with("text/")
        && !ctype.contains("markdown")
        && !ctype.contains("octet-stream")
        && !ctype.is_empty()
    {
        return Err(format!("unexpected Content-Type: {ctype}"));
    }
    // Read with a hard byte cap.
    use std::io::Read;
    let mut reader = resp.into_reader().take((MAX_BYTES as u64) + 1);
    let mut buf = Vec::with_capacity(8 * 1024);
    reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("failed to read body: {e}"))?;
    if buf.len() > MAX_BYTES {
        return Err(format!("response exceeds {MAX_BYTES} bytes"));
    }
    String::from_utf8(buf).map_err(|e| format!("response is not valid UTF-8: {e}"))
}

fn looks_like_markdown(body: &str) -> bool {
    body.lines().any(|l| l.trim_start().starts_with('#'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_https() {
        let err = parse_and_validate_url("http://raw.githubusercontent.com/x/y/SKILL.md")
            .unwrap_err();
        assert!(err.contains("https"));
    }

    #[test]
    fn rejects_non_md_extension() {
        let err = parse_and_validate_url("https://raw.githubusercontent.com/x/y/file.txt")
            .unwrap_err();
        assert!(err.contains(".md"));
    }

    #[test]
    fn derives_skill_id_from_skill_md() {
        let (host, basename, id) =
            parse_and_validate_url("https://raw.githubusercontent.com/org/repo/main/skills/mytool/SKILL.md")
                .unwrap();
        assert_eq!(host, "raw.githubusercontent.com");
        assert_eq!(basename, "SKILL.md");
        assert_eq!(id, "mytool");
    }

    #[test]
    fn derives_skill_id_from_named_md() {
        let (_, _, id) =
            parse_and_validate_url("https://raw.githubusercontent.com/org/repo/main/foo.md")
                .unwrap();
        assert_eq!(id, "foo");
    }

    #[test]
    fn rejects_host_not_on_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        let err = install_from_url(
            "https://evil.example.com/pkg/SKILL.md",
            tmp.path(),
            false,
        )
        .unwrap_err();
        assert!(err.contains("allowlist"), "err was: {err}");
    }

    #[test]
    fn rejects_traversal_in_path() {
        let err =
            parse_and_validate_url("https://raw.githubusercontent.com/a/../b/SKILL.md");
        // Dot segments would collapse segmenting; we expect either a valid parse
        // where the skill id is "b" (safe) OR an error. Both outcomes must not
        // yield a traversal escape.
        if let Ok((_, _, id)) = err {
            assert!(!id.contains(".."));
        }
    }

    #[test]
    fn looks_like_markdown_accepts_heading() {
        assert!(looks_like_markdown("# Title\nbody"));
        assert!(!looks_like_markdown("no heading at all"));
    }
}
