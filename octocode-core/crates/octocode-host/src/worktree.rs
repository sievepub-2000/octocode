use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub commit_hash: String,
    pub is_current: bool,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub current_branch: String,
}

pub fn repo_root(cwd: &Path) -> anyhow::Result<PathBuf> {
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(root.trim()))
}

pub fn list(cwd: &Path) -> anyhow::Result<Vec<Worktree>> {
    let current = repo_root(cwd)?;
    Ok(parse_worktrees(
        &run_git(cwd, &["worktree", "list", "--porcelain"])?,
        &current,
    ))
}

pub fn create(
    cwd: &Path,
    target: &Path,
    branch: Option<&str>,
    base_branch: Option<&str>,
    create_new_branch: bool,
) -> anyhow::Result<WorktreeResult> {
    if !target.is_absolute() {
        anyhow::bail!("worktree path must be absolute");
    }
    if target.exists() {
        anyhow::bail!("worktree path already exists: {}", target.display());
    }
    if let Some(branch) = branch {
        validate_branch(cwd, branch, create_new_branch)?;
    }
    if let Some(base) = base_branch {
        validate_revision(cwd, base)?;
    }

    let target = target.to_string_lossy().into_owned();
    let mut args = vec!["worktree".to_owned(), "add".to_owned()];
    if create_new_branch {
        let branch = branch
            .ok_or_else(|| anyhow::anyhow!("branch is required when creating a new branch"))?;
        args.extend(["-b".to_owned(), branch.to_owned(), target.clone()]);
        if let Some(base) = base_branch {
            args.push(base.to_owned());
        }
    } else if let Some(branch) = branch {
        args.extend([target.clone(), branch.to_owned()]);
    } else {
        args.extend(["--detach".to_owned(), target.clone()]);
        if let Some(base) = base_branch {
            args.push(base.to_owned());
        }
    }
    run_git_owned(cwd, &args)?;
    let created = list(cwd)?
        .into_iter()
        .find(|row| same_path(Path::new(&row.path), Path::new(&target)));
    Ok(WorktreeResult {
        success: true,
        message: format!("Worktree created at {target}"),
        worktree: created,
    })
}

pub fn remove(cwd: &Path, target: &Path, force: bool) -> anyhow::Result<WorktreeResult> {
    let registered = list(cwd)?
        .into_iter()
        .any(|row| same_path(Path::new(&row.path), target));
    if !registered {
        anyhow::bail!("path is not a registered worktree: {}", target.display());
    }
    let mut args = vec!["worktree".to_owned(), "remove".to_owned()];
    if force {
        args.push("--force".to_owned());
    }
    args.push(target.to_string_lossy().into_owned());
    run_git_owned(cwd, &args)?;
    Ok(WorktreeResult {
        success: true,
        message: format!("Worktree removed from {}", target.display()),
        worktree: None,
    })
}

pub fn checkout(cwd: &Path, branch: &str) -> anyhow::Result<WorktreeResult> {
    validate_revision(cwd, branch)?;
    run_git(cwd, &["checkout", branch])?;
    Ok(WorktreeResult {
        success: true,
        message: format!("Checked out branch {branch}"),
        worktree: None,
    })
}

pub fn branches(cwd: &Path) -> anyhow::Result<BranchInfo> {
    let local = run_git(cwd, &["branch", "--format=%(refname:short)"])?;
    let remote = run_git(cwd, &["branch", "-r", "--format=%(refname:short)"])?;
    let current = run_git(cwd, &["branch", "--show-current"])?;
    Ok(BranchInfo {
        local_branches: lines(&local),
        remote_branches: lines(&remote)
            .into_iter()
            .filter(|value| !value.contains("HEAD"))
            .collect(),
        current_branch: current.trim().to_owned(),
    })
}

fn validate_branch(cwd: &Path, branch: &str, new_branch: bool) -> anyhow::Result<()> {
    if branch.trim() != branch || branch.contains(['\r', '\n']) {
        anyhow::bail!("branch name is invalid");
    }
    if new_branch {
        run_git(cwd, &["check-ref-format", "--branch", branch])?;
    } else {
        validate_revision(cwd, branch)?;
    }
    Ok(())
}

fn validate_revision(cwd: &Path, revision: &str) -> anyhow::Result<()> {
    if revision.trim() != revision || revision.starts_with('-') || revision.contains(['\r', '\n']) {
        anyhow::bail!("revision is invalid");
    }
    run_git(cwd, &["rev-parse", "--verify", revision])?;
    Ok(())
}

fn run_git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run_git_owned(
        cwd,
        &args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
    )
}

fn run_git_owned(cwd: &Path, args: &[String]) -> anyhow::Result<String> {
    if !cwd.is_dir() {
        anyhow::bail!("working directory does not exist: {}", cwd.display());
    }
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if !output.status.success() {
        anyhow::bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn lines(value: &str) -> Vec<String> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_worktrees(output: &str, current: &Path) -> Vec<Worktree> {
    output
        .split("\n\n")
        .filter_map(|entry| {
            let mut row = Worktree {
                path: String::new(),
                branch: String::new(),
                commit_hash: String::new(),
                is_current: false,
                is_bare: false,
                is_detached: false,
                is_locked: false,
                lock_reason: None,
            };
            for line in entry.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    row.path = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("HEAD ") {
                    row.commit_hash = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("branch ") {
                    row.branch = value
                        .trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value.trim())
                        .to_owned();
                } else if line == "bare" {
                    row.is_bare = true;
                } else if line == "detached" {
                    row.is_detached = true;
                } else if line == "locked" {
                    row.is_locked = true;
                } else if let Some(value) = line.strip_prefix("locked ") {
                    row.is_locked = true;
                    row.lock_reason = Some(value.trim().to_owned());
                }
            }
            if row.path.is_empty() {
                return None;
            }
            row.is_current = same_path(Path::new(&row.path), current);
            Some(row)
        })
        .collect()
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_worktrees_and_marks_current_path() {
        let output = "worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree C:/repo-task\nHEAD def456\ndetached\nlocked review\n";
        let rows = parse_worktrees(output, std::path::Path::new("C:/repo-task"));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].branch, "main");
        assert!(rows[1].is_current);
        assert!(rows[1].is_detached);
        assert_eq!(rows[1].lock_reason.as_deref(), Some("review"));
    }

    #[test]
    fn real_git_worktree_create_list_remove_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        for args in [
            &["init"] as &[&str],
            &["config", "user.email", "octocode@example.invalid"],
            &["config", "user.name", "OctoCode Test"],
        ] {
            run_git(&repo, args).unwrap();
        }
        std::fs::write(repo.join("README.md"), "test\n").unwrap();
        run_git(&repo, &["add", "README.md"]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();

        let target = temp.path().join("task");
        create(&repo, &target, Some("task/test"), Some("HEAD"), true).unwrap();
        assert!(
            list(&repo)
                .unwrap()
                .iter()
                .any(|row| row.branch == "task/test")
        );
        remove(&repo, &target, false).unwrap();
        assert!(!target.exists());
    }
}
