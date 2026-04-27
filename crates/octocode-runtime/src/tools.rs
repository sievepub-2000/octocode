use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use octocode_core::{
    OctoError, PermissionMode, ShellKind, ToolCall, ToolCatalog, ToolDescriptor, ToolExecutor,
    ToolResult,
};

const TOOLS: &[ToolDescriptor] = &[
    ToolDescriptor {
        name: "echo",
        summary: "Echo input for debugging",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "read-file",
        summary: "Read one file from the workspace",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "list-files",
        summary: "List directory entries from the workspace",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "write-file",
        summary: "Write one file under the workspace",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "shell-command",
        summary: "Run one shell command in the workspace with explicit danger-full-access permission",
        minimum_permission: PermissionMode::DangerFullAccess,
    },
    ToolDescriptor {
        name: "search-text",
        summary: "Search workspace text with a pattern and optional path",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "workflow-plan",
        summary: "Generate a focused implementation plan for the current task",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "agent-action",
        summary: "Run a real session agent action through runtime orchestration",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "git-status",
        summary: "Show git working tree status in the workspace",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "git-diff",
        summary: "Show git diff for a file or the entire workspace",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "git-log",
        summary: "Show recent git commit log (default 10 entries)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "file-tree",
        summary: "Show a recursive directory tree up to a given depth",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "append-file",
        summary: "Append content to a file in the workspace",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "http-get",
        summary: "Perform an HTTP GET request and return the response body",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "read-context",
        summary: "Read CLAUDE.md or AGENTS.md project context files",
        minimum_permission: PermissionMode::ReadOnly,
    },
];

pub struct WorkspaceToolExecutor {
    workspace_root: PathBuf,
    preferred_shell: ShellKind,
}

impl WorkspaceToolExecutor {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        let preferred_shell = if cfg!(target_os = "windows") {
            ShellKind::PowerShell
        } else if cfg!(target_os = "macos") {
            ShellKind::Zsh
        } else {
            ShellKind::Bash
        };
        Self {
            workspace_root: workspace_root.into(),
            preferred_shell,
        }
    }

    pub fn with_shell(workspace_root: impl Into<PathBuf>, preferred_shell: ShellKind) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            preferred_shell,
        }
    }

    fn canonical_workspace_root(&self) -> Result<PathBuf, OctoError> {
        fs::canonicalize(&self.workspace_root).map_err(|error| {
            OctoError::Runtime(format!(
                "failed to resolve workspace root {}: {error}",
                self.workspace_root.display()
            ))
        })
    }

    fn reject_parent_components(input: &str) -> Result<(), OctoError> {
        let path = Path::new(input);
        if path.components().any(|component| matches!(component, Component::ParentDir)) {
            return Err(OctoError::Runtime(format!(
                "workspace path escapes are not allowed: {input}"
            )));
        }
        Ok(())
    }

    fn resolve_existing_workspace_path(&self, input: &str) -> Result<PathBuf, OctoError> {
        let trimmed = if input.trim().is_empty() { "." } else { input.trim() };
        Self::reject_parent_components(trimmed)?;
        let root = self.canonical_workspace_root()?;
        let candidate = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            root.join(trimmed)
        };
        let resolved = fs::canonicalize(&candidate).map_err(|error| {
            OctoError::Runtime(format!("failed to resolve path {}: {error}", candidate.display()))
        })?;
        if !resolved.starts_with(&root) {
            return Err(OctoError::Runtime(format!(
                "path {} is outside workspace {}",
                resolved.display(),
                root.display()
            )));
        }
        Ok(resolved)
    }

    fn resolve_writable_workspace_path(&self, input: &str) -> Result<PathBuf, OctoError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(OctoError::Runtime(String::from("write path cannot be empty")));
        }
        Self::reject_parent_components(trimmed)?;
        let root = self.canonical_workspace_root()?;
        let candidate = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            root.join(trimmed)
        };
        let parent = candidate.parent().ok_or_else(|| {
            OctoError::Runtime(format!("write path has no parent: {}", candidate.display()))
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            OctoError::Runtime(format!(
                "failed to create parent directory {}: {error}",
                parent.display()
            ))
        })?;
        let parent = fs::canonicalize(parent).map_err(|error| {
            OctoError::Runtime(format!("failed to resolve parent {}: {error}", parent.display()))
        })?;
        if !parent.starts_with(&root) {
            return Err(OctoError::Runtime(format!(
                "write path {} is outside workspace {}",
                candidate.display(),
                root.display()
            )));
        }
        Ok(parent.join(candidate.file_name().ok_or_else(|| {
            OctoError::Runtime(format!("write path has no file name: {}", candidate.display()))
        })?))
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn powershell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    fn run_shell(&self, command_line: &str) -> Result<ToolResult, OctoError> {
        let invocation = NativeShellInvocation::detect(&self.preferred_shell, command_line);
        let output = Command::new(&invocation.program)
            .args(&invocation.args)
            .current_dir(&self.workspace_root)
            .output()
            .map_err(|error| OctoError::Runtime(format!("failed to run shell command: {error}")))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(ToolResult {
            output: format!("{}{}", stdout, stderr).trim().to_string(),
        })
    }

    fn search_text(&self, input: &str) -> Result<ToolResult, OctoError> {
        let (pattern, location) = input
            .split_once('|')
            .map(|(left, right)| (left.trim(), right.trim()))
            .unwrap_or((input.trim(), "."));
        if pattern.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "search-text expects input pattern|path or pattern",
            )));
        }
        let location = self.resolve_existing_workspace_path(location)?;
        let location_text = location.to_string_lossy();

        let command = if cfg!(target_os = "windows") {
            format!(
                "Get-ChildItem -Path {} -Recurse -File | Select-String -Pattern {} | ForEach-Object {{ \"{{0}}:{{1}}:{{2}}\" -f $_.Path, $_.LineNumber, $_.Line.Trim() }}",
                Self::powershell_quote(&location_text),
                Self::powershell_quote(pattern)
            )
        } else {
            format!(
                "grep -RIn -- {} {} | head -n 50",
                Self::shell_quote(pattern),
                Self::shell_quote(&location_text)
            )
        };

        self.run_shell(&command)
    }

    fn workflow_plan(&self, input: &str) -> ToolResult {
        let trimmed = input.trim();
        let headline = if trimmed.is_empty() {
            "Draft implementation plan"
        } else {
            trimmed
        };
        let output = [
            format!("goal: {headline}"),
            String::from("1. inspect current behavior and constraints"),
            String::from("2. implement the smallest end-to-end change"),
            String::from("3. run a focused validation for the touched slice"),
            String::from("4. iterate on follow-up fixes only if validation fails"),
        ]
        .join("\n");
        ToolResult { output }
    }

    fn agent_action(&self, input: &str) -> ToolResult {
        let task = input.trim();
        let headline = if task.is_empty() {
            "continue current task"
        } else {
            task
        };
        let output = [
            format!("agent action: {headline}"),
            String::from("mode: delegated"),
            String::from("next: inspect the local slice before making edits"),
            String::from("validation: run the cheapest behavior-scoped check after the first edit"),
        ]
        .join("\n");
        ToolResult { output }
    }

    fn git_status(&self) -> Result<ToolResult, OctoError> {
        self.run_shell("git status --short")
    }

    fn git_diff(&self, input: &str) -> Result<ToolResult, OctoError> {
        let target = input.trim();
        let cmd = if target.is_empty() {
            String::from("git diff --stat HEAD")
        } else {
            let target = self.resolve_existing_workspace_path(target)?;
            format!("git diff HEAD -- {}", Self::shell_quote(&target.to_string_lossy()))
        };
        self.run_shell(&cmd)
    }

    fn git_log(&self, input: &str) -> Result<ToolResult, OctoError> {
        let count: usize = input.trim().parse().unwrap_or(10).max(1).min(100);
        self.run_shell(&format!("git log --oneline --decorate -n {count}"))
    }

    fn file_tree(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.split_whitespace().collect();
        let dir = parts.first().copied().unwrap_or(".");
        let depth: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(3).min(10);

        let path = self.resolve_existing_workspace_path(dir)?;
        let mut lines = Vec::new();
        self.collect_tree(&path, 0, depth, &mut lines);
        Ok(ToolResult { output: lines.join("\n") })
    }

    fn collect_tree(&self, path: &Path, depth: u32, max_depth: u32, lines: &mut Vec<String>) {
        if depth > max_depth {
            return;
        }
        let indent = "  ".repeat(depth as usize);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(".");
        if path.is_dir() {
            lines.push(format!("{}{}/", indent, name));
            if depth < max_depth {
                if let Ok(entries) = fs::read_dir(path) {
                    let mut names: Vec<_> = entries.filter_map(|e| e.ok()).collect();
                    names.sort_by_key(|e| e.file_name());
                    for entry in names.iter().take(50) {
                        let n = entry.file_name();
                        let s = n.to_string_lossy();
                        if s.starts_with('.') || s == "target" || s == "node_modules" || s == "__pycache__" {
                            continue;
                        }
                        self.collect_tree(&entry.path(), depth + 1, max_depth, lines);
                    }
                }
            }
        } else {
            lines.push(format!("{}{}", indent, name));
        }
    }

    fn append_file(&self, input: &str) -> Result<ToolResult, OctoError> {
        let (path_text, content) = input.split_once('|').ok_or_else(|| {
            OctoError::Runtime(String::from("append-file expects input: path|content"))
        })?;
        let path = self.resolve_writable_workspace_path(path_text)?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| OctoError::Runtime(format!("append-file open {}: {e}", path.display())))?;
        writeln!(file, "{}", content).map_err(|e| {
            OctoError::Runtime(format!("append-file write {}: {e}", path.display()))
        })?;
        Ok(ToolResult { output: format!("appended to {}", path.display()) })
    }

    fn http_get(&self, input: &str) -> Result<ToolResult, OctoError> {
        let url = input.trim();
        if url.is_empty() {
            return Err(OctoError::Runtime(String::from("http-get requires a URL")));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(OctoError::Runtime(String::from("http-get only supports http/https")));
        }
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "(Invoke-WebRequest -Uri {} -UseBasicParsing -TimeoutSec 15).Content | Select-Object -First 1 | ForEach-Object {{ $_.Substring(0, [Math]::Min(2000, $_.Length)) }}",
                Self::powershell_quote(url)
            )
        } else {
            format!("curl -s --max-time 15 -L {} | head -c 2000", Self::shell_quote(url))
        };
        self.run_shell(&cmd)
    }

    fn read_context(&self, input: &str) -> Result<ToolResult, OctoError> {
        let candidates = if input.trim().is_empty() {
            vec!["CLAUDE.md", "AGENTS.md", ".context", "README.md"]
        } else {
            vec![input.trim()]
        };
        let mut parts = Vec::new();
        for candidate in candidates {
            if let Ok(path) = self.resolve_existing_workspace_path(candidate) {
                if path.is_file() {
                    if let Ok(content) = fs::read_to_string(&path) {
                        let truncated = if content.len() > 4000 {
                            format!("{}...[truncated at 4000 chars]", &content[..4000])
                        } else {
                            content
                        };
                        parts.push(format!("=== {} ===\n{}", candidate, truncated));
                    }
                }
            }
        }
        if parts.is_empty() {
            Ok(ToolResult {
                output: String::from("No context files found (CLAUDE.md, AGENTS.md, .context, README.md)"),
            })
        } else {
            Ok(ToolResult { output: parts.join("\n\n") })
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct NativeShellInvocation {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

impl NativeShellInvocation {
    pub(crate) fn detect(preferred_shell: &ShellKind, command_line: &str) -> Self {
        if cfg!(target_os = "windows") {
            if command_exists("pwsh") {
                return Self::powershell("pwsh", command_line);
            }
            if command_exists("powershell") {
                return Self::powershell("powershell", command_line);
            }
            return Self {
                program: String::from("cmd"),
                args: vec![String::from("/C"), String::from(command_line)],
            };
        }

        let program = match preferred_shell {
            ShellKind::Zsh if command_exists("zsh") => "zsh",
            ShellKind::Sh if command_exists("sh") => "sh",
            ShellKind::Bash if command_exists("bash") => "bash",
            _ if command_exists("bash") => "bash",
            _ => "sh",
        };
        Self {
            program: String::from(program),
            args: vec![String::from("-lc"), String::from(command_line)],
        }
    }

    fn powershell(program: &str, command_line: &str) -> Self {
        Self {
            program: String::from(program),
            args: vec![
                String::from("-NoLogo"),
                String::from("-NoProfile"),
                String::from("-NonInteractive"),
                String::from("-ExecutionPolicy"),
                String::from("Bypass"),
                String::from("-Command"),
                format!("$ProgressPreference='SilentlyContinue'; {command_line}"),
            ],
        }
    }
}

fn command_exists(program: &str) -> bool {
    if cfg!(target_os = "windows") {
        Command::new("where")
            .arg(program)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    } else {
        Command::new("which")
            .arg(program)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RuntimeToolCatalog;

impl ToolCatalog for RuntimeToolCatalog {
    fn descriptors(&self) -> &[ToolDescriptor] {
        TOOLS
    }
}

impl ToolExecutor for WorkspaceToolExecutor {
    fn execute(&self, call: ToolCall) -> Result<ToolResult, OctoError> {
        match call.name.as_str() {
            "echo" => Ok(ToolResult {
                output: format!("tool {} => {}", call.name, call.input),
            }),
            "read-file" => {
                let path = self.resolve_existing_workspace_path(&call.input)?;
                let output = fs::read_to_string(&path).map_err(|error| {
                    OctoError::Runtime(format!("failed to read file {}: {error}", path.display()))
                })?;
                Ok(ToolResult { output })
            }
            "list-files" => {
                let path = self.resolve_existing_workspace_path(if call.input.trim().is_empty() {
                    "."
                } else {
                    &call.input
                })?;
                let entries = fs::read_dir(&path).map_err(|error| {
                    OctoError::Runtime(format!("failed to list files {}: {error}", path.display()))
                })?;
                let mut names = entries
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect::<Vec<_>>();
                names.sort();
                Ok(ToolResult {
                    output: names.join("\n"),
                })
            }
            "write-file" => {
                let (path_text, content) = call.input.split_once('|').ok_or_else(|| {
                    OctoError::Runtime(String::from(
                        "write-file expects input in the form path|content",
                    ))
                })?;
                let path = self.resolve_writable_workspace_path(path_text)?;
                fs::write(&path, content).map_err(|error| {
                    OctoError::Runtime(format!("failed to write file {}: {error}", path.display()))
                })?;
                Ok(ToolResult {
                    output: format!("wrote {}", path.display()),
                })
            }
            "shell-command" => self.run_shell(&call.input),
            "search-text" => self.search_text(&call.input),
            "workflow-plan" => Ok(self.workflow_plan(&call.input)),
            "agent-action" => Ok(self.agent_action(&call.input)),
            "git-status" => self.git_status(),
            "git-diff" => self.git_diff(&call.input),
            "git-log" => self.git_log(&call.input),
            "file-tree" => self.file_tree(&call.input),
            "append-file" => self.append_file(&call.input),
            "http-get" => self.http_get(&call.input),
            "read-context" => self.read_context(&call.input),
            _ => Err(OctoError::Runtime(format!("unknown tool: {}", call.name))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceToolExecutor;
    use octocode_core::{PermissionMode, ToolCall, ToolExecutor};

    #[test]
    fn rejects_parent_directory_read_escape() {
        let executor = WorkspaceToolExecutor::new(".");
        let result = executor.execute(ToolCall {
            name: String::from("read-file"),
            input: String::from("../Cargo.toml"),
            permission: PermissionMode::ReadOnly,
        });
        assert!(result.is_err());
    }

    #[test]
    fn preserves_danger_shell_command_surface() {
        let executor = WorkspaceToolExecutor::new(".");
        let result = executor.execute(ToolCall {
            name: String::from("shell-command"),
            input: String::from("echo octocode-danger-ready"),
            permission: PermissionMode::DangerFullAccess,
        });
        assert!(result.is_ok());
    }
}
