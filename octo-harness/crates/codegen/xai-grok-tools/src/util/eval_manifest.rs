//! Evaluation manifest: what an agent under evaluation must not reach.
//!
//! A benchmark run places `.octocode/eval-manifest.json` in the workspace. While
//! it is present, web fetches and terminal commands that would reach a blocked
//! source (the dataset's host, the upstream repository that contains the fix, the
//! package under test) are refused before they run. Without a manifest nothing
//! changes.
//!
//! ```json
//! {
//!   "blocked_url_prefixes": ["github.com/sympy/sympy", "raw.githubusercontent.com/sympy/sympy"],
//!   "blocked_packages": ["sympy"],
//!   "block_git_network": true
//! }
//! ```

use std::path::{Path, PathBuf};

const MANIFEST: &str = ".octocode/eval-manifest.json";
const SEARCH_DEPTH: usize = 8;

#[derive(Debug, Default, serde::Deserialize)]
pub struct EvalManifest {
    /// Host + path prefixes, scheme-less, matched case-insensitively.
    #[serde(default)]
    pub blocked_url_prefixes: Vec<String>,
    /// Package names that must not be installed or downloaded (pip, uv, npm).
    #[serde(default)]
    pub blocked_packages: Vec<String>,
    /// Refuse `git clone|fetch|pull|remote add` and `--index-url` overrides.
    #[serde(default)]
    pub block_git_network: bool,
}

/// The manifest governing `cwd`, if any, with the directory that holds it.
pub fn find(cwd: &Path) -> Option<(PathBuf, EvalManifest)> {
    cwd.ancestors().take(SEARCH_DEPTH).find_map(|dir| {
        let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
        Some((
            dir.to_path_buf(),
            serde_json::from_str(&text).unwrap_or_default(),
        ))
    })
}

fn normalise(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    let without_scheme = lower
        .split_once("://")
        .map_or(lower.as_str(), |(_, rest)| rest);
    without_scheme.trim_start_matches("www.").to_string()
}

impl EvalManifest {
    /// Why fetching `url` is refused, if it is.
    pub fn blocked_url(&self, url: &str) -> Option<String> {
        let target = normalise(url);
        self.blocked_url_prefixes
            .iter()
            .map(|prefix| normalise(prefix))
            .find(|prefix| !prefix.is_empty() && target.starts_with(prefix.as_str()))
            .map(|prefix| {
                format!(
                    "Blocked by the evaluation manifest: {url} is under \"{prefix}\", a source that may contain \
                     this benchmark's answers. Solve the task from the provided materials instead."
                )
            })
    }

    /// Why running `command` is refused, if it is.
    pub fn blocked_command(&self, command: &str) -> Option<String> {
        for url in extract_urls(command) {
            if let Some(reason) = self.blocked_url(&url) {
                return Some(reason);
            }
        }
        let words: Vec<String> = command
            .split(|c: char| {
                c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')' | '"' | '\'')
            })
            .filter(|w| !w.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        if self.block_git_network {
            for pair in words.windows(2) {
                if pair[0] == "git" && matches!(pair[1].as_str(), "clone" | "fetch" | "pull") {
                    return Some(format!(
                        "Blocked by the evaluation manifest: `git {}` reaches the network, where upstream history \
                         may contain the fix. Work from the repository as provided.",
                        pair[1]
                    ));
                }
            }
            if words
                .windows(3)
                .any(|w| w[0] == "git" && w[1] == "remote" && w[2] == "add")
                || words
                    .iter()
                    .any(|w| w.starts_with("--index-url") || w.starts_with("--extra-index-url"))
            {
                return Some(
                    "Blocked by the evaluation manifest: adding git remotes or package indexes is not allowed \
                     during evaluation."
                        .to_string(),
                );
            }
        }
        for package_name in installed_packages(command) {
            let name = package_name
                .split(|c: char| matches!(c, '=' | '<' | '>' | '[' | '~' | '!' | '@'))
                .next()
                .unwrap_or(&package_name);
            if let Some(package) = self
                .blocked_packages
                .iter()
                .map(|p| p.to_ascii_lowercase())
                .find(|package| {
                    name == package.as_str() || name.starts_with(&format!("{package}-"))
                })
            {
                return Some(format!(
                    "Blocked by the evaluation manifest: installing `{package}` would bring in a released version \
                     of the code under test. Use the repository as provided (e.g. `pip install -e .`)."
                ));
            }
        }
        None
    }
}

/// Package arguments of install commands, per command segment.
///
/// Only the non-option words after `pip|pip3|uv pip|npm|pnpm install|download|add|i`
/// in the same segment count. Matching the whole line flagged
/// `pip install -e .; python -c "import sympy"` as installing sympy.
fn installed_packages(command: &str) -> Vec<String> {
    let mut packages = Vec::new();
    for segment in command.split(|c: char| matches!(c, ';' | '|' | '&' | '\n' | '\r')) {
        let words: Vec<String> = segment
            .split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '"' | '\''))
            .filter(|w| !w.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        let Some(verb) = words.windows(2).position(|w| {
            matches!(w[0].as_str(), "pip" | "pip3" | "uv" | "npm" | "pnpm")
                && matches!(w[1].as_str(), "install" | "download" | "add" | "i")
        }) else {
            continue;
        };
        // Arguments that take a value: skip the value too.
        let mut skip_next = false;
        for word in &words[verb + 2..] {
            if skip_next {
                skip_next = false;
                continue;
            }
            if word.starts_with('-') {
                skip_next = matches!(
                    word.as_str(),
                    "-r" | "-c"
                        | "-t"
                        | "--target"
                        | "--prefix"
                        | "-e"
                        | "--editable"
                        | "--requirement"
                        | "--constraint"
                );
                continue;
            }
            packages.push(word.clone());
        }
    }
    packages
}

fn extract_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("http") {
        let candidate = &rest[start..];
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            let end = candidate
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '<' | '>' | '`')
                })
                .unwrap_or(candidate.len());
            urls.push(candidate[..end].to_string());
            rest = &candidate[end..];
        } else {
            rest = &candidate[4..];
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> EvalManifest {
        EvalManifest {
            blocked_url_prefixes: vec![
                "github.com/sympy/sympy".into(),
                "raw.githubusercontent.com/sympy".into(),
            ],
            blocked_packages: vec!["sympy".into()],
            block_git_network: true,
        }
    }

    #[test]
    fn upstream_urls_are_blocked_in_fetches_and_commands() {
        let m = manifest();
        assert!(
            m.blocked_url(
                "https://raw.githubusercontent.com/sympy/sympy/master/sympy/polys/factortools.py"
            )
            .is_some()
        );
        assert!(
            m.blocked_url("https://GitHub.com/sympy/sympy/commit/abc")
                .is_some()
        );
        assert!(
            m.blocked_url("https://en.wikipedia.org/wiki/SymPy")
                .is_none()
        );
        assert!(
            m.blocked_command("curl -s https://raw.githubusercontent.com/sympy/sympy/master/x.py")
                .is_some()
        );
        assert!(m.blocked_command("python -c \"import urllib.request as u; u.urlopen('https://github.com/sympy/sympy')\"").is_some());
    }

    #[test]
    fn git_network_and_package_installs_are_blocked() {
        let m = manifest();
        assert!(m.blocked_command("git fetch origin").is_some());
        assert!(
            m.blocked_command("cd repo; git remote add up https://example.com/x.git")
                .is_some()
        );
        assert!(m.blocked_command("pip install sympy==1.13").is_some());
        assert!(
            m.blocked_command("python -m pip install --index-url https://mirror/simple mpmath")
                .is_some()
        );
        assert!(m.blocked_command("uv pip install sympy").is_some());
    }

    #[test]
    fn only_install_arguments_count_as_packages() {
        let m = manifest();
        // The SWE-bench run 2 false positive: editable install of the repo, then an import check.
        let line = "& 'D:\\bench\\venv\\Scripts\\python.exe' -m pip install --quiet setuptools; \
                    Push-Location 'D:\\bench\\tasks\\sympy__sympy-19254\\repo'; \
                    & python -m pip install --no-build-isolation --no-deps -e .; python -c \"import sympy; print(sympy.__version__)\"";
        assert_eq!(m.blocked_command(line), None);
        assert!(
            m.blocked_command("python -m pip install --quiet mpmath sympy==1.12")
                .is_some()
        );
        assert!(
            m.blocked_command("cd repo; pip install -e .; pip install sympy")
                .is_some()
        );
    }

    #[test]
    fn ordinary_work_is_allowed() {
        let m = manifest();
        assert!(m.blocked_command("git diff").is_none());
        assert!(
            m.blocked_command("git status && git log --oneline -3")
                .is_none()
        );
        assert!(m.blocked_command("pip install mpmath pytest").is_none());
        assert!(m.blocked_command("pip install -e .").is_none());
        assert!(
            m.blocked_command("python -m pytest sympy/polys/tests/test_factortools.py")
                .is_none()
        );
    }

    #[test]
    fn manifest_is_found_above_the_session_directory() {
        let tmp = tempfile::TempDir::new().unwrap();
        let workspace = tmp.path();
        std::fs::create_dir_all(workspace.join(".octocode/sessions/abc")).unwrap();
        std::fs::write(
            workspace.join(MANIFEST),
            r#"{"blocked_packages": ["sympy"]}"#,
        )
        .unwrap();
        let (root, found) = find(&workspace.join(".octocode/sessions/abc")).unwrap();
        assert_eq!(root, workspace);
        assert_eq!(found.blocked_packages, vec!["sympy".to_string()]);
    }
}
