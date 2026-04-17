use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use octocode_core::{
    OctoError, PermissionMode, ShellKind, ToolCall, ToolCatalog, ToolDescriptor, ToolExecutor,
    ToolResult,
};

const TOOLS: &[ToolDescriptor] = &[
    // ── original 8 ──────────────────────────────────────────────────────────
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
        summary: "Run one shell command in the workspace",
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
    // ── iteration 1: 7 new tools ────────────────────────────────────────────
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

    fn resolve_workspace_path(&self, input: &str) -> PathBuf {
        let path = Path::new(input);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.workspace_root.join(path)
        }
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

        let command = if cfg!(target_os = "windows") {
            format!(
                "Get-ChildItem -Path '{}' -Recurse -File | Select-String -Pattern '{}' | ForEach-Object {{ \"{{0}}:{{1}}:{{2}}\" -f $_.Path, $_.LineNumber, $_.Line.Trim() }}",
                location.replace('\'', "''"),
                pattern.replace('\'', "''")
            )
        } else {
            format!(
                "grep -RIn -- '{}' '{}' | head -n 50",
                pattern.replace('\'', "'\\''"),
                location.replace('\'', "'\\''")
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
            format!("git diff HEAD -- {}", target.replace('"', "\\\""))
        };
        self.run_shell(&cmd)
    }

    fn git_log(&self, input: &str) -> Result<ToolResult, OctoError> {
        let count: usize = input.trim().parse().unwrap_or(10).max(1).min(100);
        let cmd = format!(
            "git log --oneline --decorate -n {}",
            count
        );
        self.run_shell(&cmd)
    }

    fn file_tree(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.split_whitespace().collect();
        let dir = parts.first().copied().unwrap_or(".");
        let depth: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(3).min(10);

        let path = self.resolve_workspace_path(dir);
        let mut lines = Vec::new();
        self.collect_tree(&path, 0, depth, &mut lines);
        Ok(ToolResult { output: lines.join("\n") })
    }

    fn collect_tree(&self, path: &std::path::Path, depth: u32, max_depth: u32, lines: &mut Vec<String>) {
        if depth > max_depth {
            return;
        }
        let indent = "  ".repeat(depth as usize);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(".");
        if path.is_dir() {
            lines.push(format!("{}{}/", indent, name));
            if depth < max_depth {
                if let Ok(entries) = fs::read_dir(path) {
                    let mut names: Vec<_> = entries
                        .filter_map(|e| e.ok())
                        .collect();
                    names.sort_by_key(|e| e.file_name());
                    // Skip hidden and common noise dirs
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
        let path = self.resolve_workspace_path(path_text.trim());
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
        // Security: only allow http/https schemes
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(OctoError::Runtime(String::from("http-get only supports http/https")));
        }
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "(Invoke-WebRequest -Uri '{}' -UseBasicParsing -TimeoutSec 15).Content | Select-Object -First 1 | ForEach-Object {{ $_.Substring(0, [Math]::Min(2000, $_.Length)) }}",
                url.replace('\'', "''")
            )
        } else {
            format!("curl -s --max-time 15 -L '{}' | head -c 2000", url.replace('\'', "'\\''"))
        };
        self.run_shell(&cmd)
    }

    fn read_context(&self, input: &str) -> Result<ToolResult, OctoError> {
        // Read CLAUDE.md, AGENTS.md, or .context files for project context
        let candidates = if input.trim().is_empty() {
            vec!["CLAUDE.md", "AGENTS.md", ".context", "README.md"]
        } else {
            vec![input.trim()]
        };
        let mut parts = Vec::new();
        for candidate in candidates {
            let path = self.resolve_workspace_path(candidate);
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
                let path = self.resolve_workspace_path(&call.input);
                let output = fs::read_to_string(&path).map_err(|error| {
                    OctoError::Runtime(format!("failed to read file {}: {error}", path.display()))
                })?;
                Ok(ToolResult { output })
            }
            "list-files" => {
                let path = self.resolve_workspace_path(if call.input.trim().is_empty() {
                    "."
                } else {
                    &call.input
                });
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
                let path = self.resolve_workspace_path(path_text.trim());
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        OctoError::Runtime(format!(
                            "failed to create parent directory {}: {error}",
                            parent.display()
                        ))
                    })?;
                }
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
            // iteration-1 tools
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