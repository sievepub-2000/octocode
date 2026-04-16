use std::fs;
use std::path::{Path, PathBuf};
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
            _ => Err(OctoError::Runtime(format!("unknown tool: {}", call.name))),
        }
    }
}