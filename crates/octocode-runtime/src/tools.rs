use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::file_guard;
use octocode_core::{
    OctoError, PermissionMode, ShellKind, ToolCall, ToolCatalog, ToolDescriptor, ToolExecutor,
    ToolResult,
};

/// Maximum output size returned by any tool (64 KB).
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// Maximum file size that read-file will load (1 MB).
const MAX_READ_FILE_BYTES: u64 = 1024 * 1024;
/// Default timeout for shell commands (30 seconds).
const SHELL_TIMEOUT: Duration = Duration::from_secs(30);
const APPROVAL_INPUT_PREFIX: &str = "__approve:";

static APPROVAL_TOKEN_SEQ: AtomicU64 = AtomicU64::new(1);
static APPROVAL_TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

/// Truncate a string to at most `max_bytes` with a marker when trimmed.
fn truncate_output(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[output truncated — {} bytes total]", &text[..end], text.len())
}

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
    // ── iteration 2: 5 new tools ────────────────────────────────────────────
    ToolDescriptor {
        name: "create-file",
        summary: "Create a new file (auto-creates parent dirs)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "delete-file",
        summary: "Delete a file inside the workspace",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "move-file",
        summary: "Move or rename a file inside the workspace (src|dst)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "task-submit",
        summary: "Record a task entry in the current session log",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "task-list",
        summary: "List task entries recorded in the current session log",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── iteration 3: tool integrations (opencli-rs / cli-anything / lightpanda) ─
    ToolDescriptor {
        name: "web-browse",
        summary: "Fetch and extract text from a URL (headless / lightpanda)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "cli-pipe",
        summary: "Run a structured CLI pipeline (cmd1 | cmd2 | ...)",
        minimum_permission: PermissionMode::DangerFullAccess,
    },
    ToolDescriptor {
        name: "cargo-eval",
        summary: "Run cargo check/test/build in a Rust project directory",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "patch-file",
        summary: "Apply search-and-replace patch to a file (old|new|path)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "diagnostics",
        summary: "Show system diagnostics (memory, disk, processes)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── iteration 4: practical utility tools ─────────────────────────────────
    ToolDescriptor {
        name: "http-post",
        summary: "Perform an HTTP POST request with body (url|body|content-type)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "json-query",
        summary: "Extract a value from JSON text by dot-path (path|json)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "process-list",
        summary: "List running processes (optional filter pattern)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "env-var",
        summary: "Read one or all environment variables",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "base64",
        summary: "Base64 encode or decode text (encode|text or decode|text)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── LinkMind integration tools ───────────────────────────────────────────
    ToolDescriptor {
        name: "vector-search",
        summary: "Semantic vector search via LinkMind RAG (query|category|topN)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "vector-upsert",
        summary: "Upsert document into LinkMind vector store (category|content|filename)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    // ── coordinator tools ────────────────────────────────────────────────────
    ToolDescriptor {
        name: "team-create",
        summary: "Create a multi-agent team (goal|role1,role2,...)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "team-list",
        summary: "List all agent teams and their status",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "team-delete",
        summary: "Delete an agent team by ID",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "agent-message",
        summary: "Send a message between agents (from|to|content)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "team-status",
        summary: "Get detailed status and summary for a team by ID",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── todo tools ───────────────────────────────────────────────────────────
    ToolDescriptor {
        name: "todo-add",
        summary: "Add a persistent todo item to the workspace",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "todo-list",
        summary: "List all persistent todo items in the workspace",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "todo-done",
        summary: "Mark a todo item as completed by ID",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    // ── task lifecycle extension ─────────────────────────────────────────────
    ToolDescriptor {
        name: "task-get",
        summary: "Get a task record by ID from the task store",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── web search ───────────────────────────────────────────────────────────
    ToolDescriptor {
        name: "web-search",
        summary: "Search the web via DuckDuckGo Lite (query string)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── cost tracking ────────────────────────────────────────────────────────
    ToolDescriptor {
        name: "cost-summary",
        summary: "Show token usage and estimated cost summary",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── memory tools ─────────────────────────────────────────────────────────
    ToolDescriptor {
        name: "memory-save",
        summary: "Save a memory note (scope|id|content) — scope: project or user",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "memory-read",
        summary: "Read a memory note by id (scope|id)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "memory-list",
        summary: "List all memory notes in a scope (project or user)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "memory-search",
        summary: "Search memory notes for a pattern (query string)",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "memory-delete",
        summary: "Delete a memory note (scope|id)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    // ── sub-agent tools ──────────────────────────────────────────────────────
    ToolDescriptor {
        name: "subagent-spawn",
        summary: "Spawn a sub-agent for a delegated task (goal description)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "subagent-status",
        summary: "Check status of a sub-agent by ID",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "subagent-list",
        summary: "List all sub-agent tasks and their states",
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

    /// Ensure a resolved path is inside the workspace root (path traversal guard).
    fn security_check_path(&self, path: &Path) -> Result<(), OctoError> {
        let canonical_root = self
            .workspace_root
            .canonicalize()
            .unwrap_or_else(|_| self.workspace_root.clone());

        let mut probe = if path.exists() {
            path.to_path_buf()
        } else {
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(&self.workspace_root)
                .to_path_buf()
        };

        while !probe.exists() {
            let Some(parent) = probe.parent() else {
                break;
            };
            if parent == probe {
                break;
            }
            probe = parent.to_path_buf();
        }

        let check_base = probe.canonicalize().unwrap_or(probe);
        if !check_base.starts_with(&canonical_root) {
            return Err(OctoError::Runtime(format!(
                "path '{}' is outside the workspace root",
                path.display()
            )));
        }
        Ok(())
    }

    fn enforce_approval<F>(
        &self,
        tool_name: &str,
        raw_input: &str,
        target_builder: F,
    ) -> Result<String, OctoError>
    where
        F: Fn(&str) -> String,
    {
        let (provided_token, payload) = split_approval_input(raw_input);
        let key = approval_key(tool_name, payload);
        let target = target_builder(payload);

        let mut store = approval_tokens()
            .lock()
            .map_err(|_| OctoError::Runtime(String::from("approval token store lock poisoned")))?;

        if let Some(token) = provided_token {
            match store.get(&key) {
                Some(expected) if expected == token => {
                    store.remove(&key);
                    return Ok(String::from(payload));
                }
                Some(_) => {
                    return Err(OctoError::Runtime(format!(
                        "approval token mismatch for {tool_name} ({target})"
                    )));
                }
                None => {
                    return Err(OctoError::Runtime(format!(
                        "approval token missing or expired for {tool_name} ({target})"
                    )));
                }
            }
        }

        let seq = APPROVAL_TOKEN_SEQ.fetch_add(1, Ordering::SeqCst);
        let token = format!("appr-{seq}");
        store.insert(key, token.clone());
        Err(OctoError::Runtime(format!(
            "approval required for {tool_name} ({target}). re-run with input: {APPROVAL_INPUT_PREFIX}{token}|{payload}"
        )))
    }

    fn run_shell(&self, command_line: &str) -> Result<ToolResult, OctoError> {
        self.run_shell_with_timeout(command_line, SHELL_TIMEOUT)
    }

    fn run_shell_with_timeout(&self, command_line: &str, timeout: Duration) -> Result<ToolResult, OctoError> {
        let invocation = NativeShellInvocation::detect(&self.preferred_shell, command_line);
        let program = invocation.program.clone();
        let args = invocation.args.clone();
        let cwd = self.workspace_root.clone();

        // Spawn the child process directly so we can kill it on timeout.
        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| OctoError::Runtime(format!("failed to spawn shell: {e}")))?;

        // Wait in a thread so we can enforce a wall-clock timeout.
        let timeout_ms = timeout.as_millis() as u64;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    // Process exited — collect output.
                    let output = child.wait_with_output()
                        .map_err(|e| OctoError::Runtime(format!("failed to read output: {e}")))?;
                    let combined = format!(
                        "{}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                    return Ok(ToolResult {
                        output: truncate_output(combined.trim(), MAX_OUTPUT_BYTES),
                    });
                }
                Ok(None) => {
                    // Still running — check timeout.
                    if start.elapsed().as_millis() as u64 >= timeout_ms {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(OctoError::Runtime(format!(
                            "shell command timed out after {}s and was killed",
                            timeout.as_secs()
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(OctoError::Runtime(format!("wait error: {e}")));
                }
            }
        }
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
        let count: usize = input.trim().parse().unwrap_or(10).clamp(1, 100);
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
        self.security_check_path(&path)?;
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
        self.security_check_path(&path)?;
        file_guard::guard_write(&path, content.as_bytes(), &self.workspace_root)?;
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

    // ── iteration-3 tool implementations ─────────────────────────────────────

    fn web_browse(&self, input: &str) -> Result<ToolResult, OctoError> {
        let url = input.trim();
        if url.is_empty() {
            return Err(OctoError::Runtime(String::from("web-browse requires a URL")));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(OctoError::Runtime(String::from("web-browse only supports http/https")));
        }
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "(Invoke-WebRequest -Uri '{}' -UseBasicParsing -TimeoutSec 20).Content | Out-String | ForEach-Object {{ if ($_.Length -gt 8000) {{ $_.Substring(0,8000) + '...[truncated]' }} else {{ $_ }} }}",
                url.replace('\'', "''")
            )
        } else {
            format!(
                "curl -s --max-time 20 -L '{}' | head -c 8000",
                url.replace('\'', "'\\''")
            )
        };
        self.run_shell(&cmd)
    }

    fn cli_pipe(&self, input: &str) -> Result<ToolResult, OctoError> {
        let pipeline = input.trim();
        if pipeline.is_empty() {
            return Err(OctoError::Runtime(String::from("cli-pipe requires a pipeline string")));
        }
        // Delegate the whole pipeline to the shell which handles | natively
        self.run_shell(pipeline)
    }

    fn cargo_eval(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.splitn(2, '|').collect();
        let action = parts[0].trim();
        let dir = if parts.len() > 1 && !parts[1].trim().is_empty() {
            parts[1].trim()
        } else {
            "."
        };
        let valid_actions = ["check", "test", "build", "clippy"];
        if !valid_actions.contains(&action) {
            return Err(OctoError::Runtime(format!(
                "cargo-eval action must be one of: {}",
                valid_actions.join(", ")
            )));
        }
        let path = self.resolve_workspace_path(dir);
        let cmd = format!(
            "cd '{}'; cargo {} 2>&1",
            path.display().to_string().replace('\'', "''"),
            action
        );
        self.run_shell(&cmd)
    }

    fn patch_file(&self, input: &str) -> Result<ToolResult, OctoError> {
        // Format: old_text|new_text|file_path
        let segments: Vec<&str> = input.splitn(3, '|').collect();
        if segments.len() < 3 {
            return Err(OctoError::Runtime(String::from(
                "patch-file expects old|new|path"
            )));
        }
        let old_text = segments[0];
        let new_text = segments[1];
        let path = self.resolve_workspace_path(segments[2].trim());
        self.security_check_path(&path)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| OctoError::Runtime(format!("patch-file read: {e}")))?;
        let count = content.matches(old_text).count();
        if count == 0 {
            return Err(OctoError::Runtime(String::from(
                "patch-file: old text not found in file"
            )));
        }
        let patched = content.replacen(old_text, new_text, 1);
        fs::write(&path, patched)
            .map_err(|e| OctoError::Runtime(format!("patch-file write: {e}")))?;
        Ok(ToolResult {
            output: format!("patched {} ({} occurrence(s) found, replaced first)", path.display(), count),
        })
    }

    fn diagnostics(&self) -> Result<ToolResult, OctoError> {
        let cmd = if cfg!(target_os = "windows") {
            String::from(
                "$mem = Get-CimInstance Win32_OperatingSystem; \
                 $cpu = (Get-CimInstance Win32_Processor).LoadPercentage; \
                 $disk = Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{N='UsedGB';E={[math]::Round($_.Used/1GB,1)}},@{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}}; \
                 \"Memory: $([math]::Round(($mem.TotalVisibleMemorySize-$mem.FreePhysicalMemory)/1MB,1))GB / $([math]::Round($mem.TotalVisibleMemorySize/1MB,1))GB\"; \
                 \"CPU: ${cpu}%\"; \
                 $disk | Format-Table -AutoSize | Out-String"
            )
        } else {
            String::from("echo '--- Memory ---'; free -h 2>/dev/null || vm_stat; echo '--- Disk ---'; df -h / ; echo '--- CPU ---'; uptime")
        };
        self.run_shell(&cmd)
    }

    // ── iteration-4 utility tool implementations ─────────────────────────────

    fn http_post(&self, input: &str) -> Result<ToolResult, OctoError> {
        // Format: url|body|content-type  (content-type optional, default application/json)
        let parts: Vec<&str> = input.splitn(3, '|').collect();
        if parts.len() < 2 {
            return Err(OctoError::Runtime(String::from(
                "http-post expects url|body or url|body|content-type"
            )));
        }
        let url = parts[0].trim();
        let body = parts[1];
        let content_type = if parts.len() > 2 && !parts[2].trim().is_empty() {
            parts[2].trim()
        } else {
            "application/json"
        };
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(OctoError::Runtime(String::from("http-post only supports http/https")));
        }
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "$body = @'\n{}\n'@; Invoke-RestMethod -Uri '{}' -Method Post -Body $body -ContentType '{}' -TimeoutSec 15 | ConvertTo-Json -Depth 5",
                body.replace('\'', "''"),
                url.replace('\'', "''"),
                content_type.replace('\'', "''"),
            )
        } else {
            format!(
                "curl -s --max-time 15 -X POST -H 'Content-Type: {}' -d '{}' '{}'",
                content_type.replace('\'', "'\\''"),
                body.replace('\'', "'\\''"),
                url.replace('\'', "'\\''"),
            )
        };
        self.run_shell(&cmd)
    }

    fn json_query(&self, input: &str) -> Result<ToolResult, OctoError> {
        // Format: dot.path|json_text
        let (path_str, json_text) = input.split_once('|').ok_or_else(|| {
            OctoError::Runtime(String::from("json-query expects path|json"))
        })?;
        let path_str = path_str.trim();
        let json_text = json_text.trim();
        // Simple dot-path navigator for JSON
        // Parse as serde_json::Value would be ideal, but we keep deps minimal.
        // Use PowerShell/jq for real queries.
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "$j = '{}' | ConvertFrom-Json; $j.{} | ConvertTo-Json -Depth 5",
                json_text.replace('\'', "''"),
                path_str.replace('\'', "''"),
            )
        } else {
            format!(
                "echo '{}' | jq '.{}'",
                json_text.replace('\'', "'\\''"),
                path_str.replace('\'', "'\\''"),
            )
        };
        self.run_shell(&cmd)
    }

    fn process_list(&self, input: &str) -> Result<ToolResult, OctoError> {
        let filter = input.trim();
        let cmd = if cfg!(target_os = "windows") {
            if filter.is_empty() {
                String::from("Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 25 Id, ProcessName, @{N='CPU_s';E={[math]::Round($_.CPU,1)}}, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String")
            } else {
                format!(
                    "Get-Process | Where-Object {{ $_.ProcessName -like '*{}*' }} | Sort-Object -Property CPU -Descending | Select-Object Id, ProcessName, @{{N='CPU_s';E={{[math]::Round($_.CPU,1)}}}}, @{{N='MemMB';E={{[math]::Round($_.WorkingSet64/1MB,1)}}}} | Format-Table -AutoSize | Out-String",
                    filter.replace('\'', "''")
                )
            }
        } else if filter.is_empty() {
            String::from("ps aux --sort=-%cpu | head -n 25")
        } else {
            format!("ps aux | grep -i '{}' | head -n 25", filter.replace('\'', "'\\''"))
        };
        self.run_shell(&cmd)
    }

    fn env_var(&self, input: &str) -> Result<ToolResult, OctoError> {
        let name = input.trim();
        if name.is_empty() {
            // List all env vars
            let cmd = if cfg!(target_os = "windows") {
                String::from("Get-ChildItem Env: | Sort-Object Name | Format-Table Name, Value -AutoSize -Wrap | Out-String -Width 200 | Select-Object -First 80")
            } else {
                String::from("env | sort | head -n 80")
            };
            self.run_shell(&cmd)
        } else {
            // Validate name: only alphanumeric and underscore
            if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return Err(OctoError::Runtime(String::from(
                    "env-var name must be alphanumeric/underscore only"
                )));
            }
            match std::env::var(name) {
                Ok(val) => Ok(ToolResult { output: val }),
                Err(_) => Ok(ToolResult { output: format!("(not set: {name})") }),
            }
        }
    }

    fn base64_tool(&self, input: &str) -> Result<ToolResult, OctoError> {
        let (action, text) = input.split_once('|').ok_or_else(|| {
            OctoError::Runtime(String::from("base64 expects encode|text or decode|text"))
        })?;
        let action = action.trim().to_lowercase();
        let text = text.trim();
        match action.as_str() {
            "encode" => {
                use std::io::Write;
                let mut buf = Vec::new();
                // Simple base64 encode without external dep
                let encoded = base64_encode(text.as_bytes());
                let _ = write!(buf, "{encoded}");
                Ok(ToolResult { output: encoded })
            }
            "decode" => {
                let decoded_bytes = base64_decode(text)?;
                let output = String::from_utf8(decoded_bytes)
                    .map_err(|e| OctoError::Runtime(format!("base64 decode not valid UTF-8: {e}")))?;
                Ok(ToolResult { output })
            }
            _ => Err(OctoError::Runtime(String::from(
                "base64 action must be 'encode' or 'decode'"
            ))),
        }
    }

    fn vector_search(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.splitn(3, '|').collect();
        let query = parts.first().map(|s| s.trim()).unwrap_or("");
        let category = parts.get(1).map(|s| s.trim()).unwrap_or("default");
        let top_n: usize = parts
            .get(2)
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(5);

        if query.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "vector-search expects query|category|topN",
            )));
        }

        let base_url = std::env::var("OCTOCODE_BASE_URL")
            .unwrap_or_else(|_| String::from("http://127.0.0.1:8080"));
        let url = format!("{base_url}/v1/vector/search");
        let body = format!(
            "{{\"text\":\"{}\",\"category\":\"{}\",\"n\":{}}}",
            escape_json_value(query),
            escape_json_value(category),
            top_n
        );

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout_read(std::time::Duration::from_secs(30))
            .build();

        let mut req = agent.post(&url);
        req = req.set("Content-Type", "application/json");
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            if !key.is_empty() {
                req = req.set("Authorization", &format!("Bearer {key}"));
            }
        }

        let resp = req.send_string(&body).map_err(|e| {
            OctoError::Runtime(format!("vector-search request failed: {e}"))
        })?;

        let output = resp.into_string().map_err(|e| {
            OctoError::Runtime(format!("vector-search response read error: {e}"))
        })?;

        Ok(ToolResult {
            output: truncate_output(&output, MAX_OUTPUT_BYTES),
        })
    }

    fn vector_upsert(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.splitn(3, '|').collect();
        if parts.len() < 2 {
            return Err(OctoError::Runtime(String::from(
                "vector-upsert expects category|content|filename",
            )));
        }
        let category = parts[0].trim();
        let content = parts[1].trim();
        let filename = parts.get(2).map(|s| s.trim()).unwrap_or("inline");

        let base_url = std::env::var("OCTOCODE_BASE_URL")
            .unwrap_or_else(|_| String::from("http://127.0.0.1:8080"));
        let url = format!("{base_url}/v1/vector/upsert");
        let body = format!(
            "{{\"category\":\"{}\",\"content\":\"{}\",\"filename\":\"{}\"}}",
            escape_json_value(category),
            escape_json_value(content),
            escape_json_value(filename)
        );

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout_read(std::time::Duration::from_secs(30))
            .build();

        let mut req = agent.post(&url);
        req = req.set("Content-Type", "application/json");
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            if !key.is_empty() {
                req = req.set("Authorization", &format!("Bearer {key}"));
            }
        }

        let resp = req.send_string(&body).map_err(|e| {
            OctoError::Runtime(format!("vector-upsert request failed: {e}"))
        })?;

        let output = resp.into_string().map_err(|e| {
            OctoError::Runtime(format!("vector-upsert response read error: {e}"))
        })?;

        Ok(ToolResult {
            output: truncate_output(&output, MAX_OUTPUT_BYTES),
        })
    }

    // ── coordinator tool implementations ─────────────────────────────────────

    fn team_create(&self, input: &str) -> Result<ToolResult, OctoError> {
        use crate::coordinator::{AgentRole, CoordinatorEngine};
        let (goal, roles_str) = input.split_once('|').ok_or_else(|| {
            OctoError::Runtime(String::from("team-create expects goal|role1,role2,..."))
        })?;
        let roles: Vec<AgentRole> = roles_str
            .split(',')
            .map(|r| match r.trim().to_lowercase().as_str() {
                "architect" => AgentRole::Architect,
                "executor" => AgentRole::Executor,
                "reviewer" => AgentRole::Reviewer,
                other => AgentRole::Custom(String::from(other)),
            })
            .collect();
        let engine = CoordinatorEngine::new();
        let team = engine.create_team(goal.trim(), &roles);
        Ok(ToolResult {
            output: format!("created team '{}' with {} agents (id: {})", team.goal, team.agents.len(), team.id),
        })
    }

    fn team_list(&self) -> Result<ToolResult, OctoError> {
        // Stateless — the real coordinator lives on the runtime
        Ok(ToolResult {
            output: String::from("team-list: use runtime.coordinator.list_teams() for live data"),
        })
    }

    fn team_delete(&self, input: &str) -> Result<ToolResult, OctoError> {
        let id = input.trim();
        if id.is_empty() {
            return Err(OctoError::Runtime(String::from("team-delete requires a team ID")));
        }
        Ok(ToolResult {
            output: format!("team-delete: request to delete team '{id}' (delegated to runtime coordinator)"),
        })
    }

    fn agent_message(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.splitn(3, '|').collect();
        if parts.len() < 3 {
            return Err(OctoError::Runtime(String::from(
                "agent-message expects from|to|content"
            )));
        }
        Ok(ToolResult {
            output: format!(
                "agent-message: {} -> {}: {}",
                parts[0].trim(),
                parts[1].trim(),
                parts[2].trim()
            ),
        })
    }

    fn team_status(&self, input: &str) -> Result<ToolResult, OctoError> {
        let id = input.trim();
        if id.is_empty() {
            return Err(OctoError::Runtime(String::from("team-status requires a team ID")));
        }
        Ok(ToolResult {
            output: format!("team-status: query team '{id}' (delegated to runtime coordinator)"),
        })
    }

    // ── todo tool implementations ────────────────────────────────────────────

    fn todo_add(&self, input: &str) -> Result<ToolResult, OctoError> {
        let store = crate::todo_store::TodoStore::new(&self.workspace_root);
        let text = input.trim();
        if text.is_empty() {
            return Err(OctoError::Runtime(String::from("todo-add requires text")));
        }
        let item = store.add(text)?;
        Ok(ToolResult {
            output: format!("added todo #{}: {}", item.id, item.text),
        })
    }

    fn todo_list(&self) -> Result<ToolResult, OctoError> {
        let store = crate::todo_store::TodoStore::new(&self.workspace_root);
        let items = store.list()?;
        if items.is_empty() {
            return Ok(ToolResult { output: String::from("no todos") });
        }
        let lines: Vec<String> = items
            .iter()
            .map(|i| {
                let mark = if i.done { "x" } else { " " };
                format!("[{mark}] #{}: {}", i.id, i.text)
            })
            .collect();
        Ok(ToolResult { output: lines.join("\n") })
    }

    fn todo_done(&self, input: &str) -> Result<ToolResult, OctoError> {
        let store = crate::todo_store::TodoStore::new(&self.workspace_root);
        let id: u32 = input.trim().parse().map_err(|_| {
            OctoError::Runtime(String::from("todo-done requires a numeric ID"))
        })?;
        if store.complete(id)? {
            Ok(ToolResult { output: format!("marked todo #{id} as done") })
        } else {
            Ok(ToolResult { output: format!("todo #{id} not found") })
        }
    }

    // ── task lifecycle ───────────────────────────────────────────────────────

    fn task_get(&self, input: &str) -> Result<ToolResult, OctoError> {
        let id = input.trim();
        if id.is_empty() {
            return Err(OctoError::Runtime(String::from("task-get requires a task ID")));
        }
        Ok(ToolResult {
            output: format!("task-get: query task '{id}' (delegated to runtime.task_store)"),
        })
    }

    // ── web search ───────────────────────────────────────────────────────────

    fn web_search(&self, input: &str) -> Result<ToolResult, OctoError> {
        let query = input.trim();
        if query.is_empty() {
            return Err(OctoError::Runtime(String::from("web-search requires a query")));
        }
        // Use DuckDuckGo Lite via shell
        let encoded = query.replace(' ', "+");
        let url = format!("https://lite.duckduckgo.com/lite/?q={encoded}");
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "(Invoke-WebRequest -Uri '{}' -UseBasicParsing -TimeoutSec 15).Content -replace '<[^>]+>','' | Out-String | ForEach-Object {{ if ($_.Length -gt 4000) {{ $_.Substring(0,4000) + '...[truncated]' }} else {{ $_ }} }}",
                url.replace('\'', "''")
            )
        } else {
            format!(
                "curl -s --max-time 15 -L '{}' | sed 's/<[^>]*>//g' | head -c 4000",
                url.replace('\'', "'\\''")
            )
        };
        self.run_shell(&cmd)
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

// ── base64 helpers (no external dep) ────────────────────────────────────────

const B64_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, OctoError> {
    fn b64_val(c: u8) -> Result<u8, OctoError> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(OctoError::Runtime(format!("invalid base64 char: {}", c as char))),
        }
    }
    let clean: Vec<u8> = input.bytes().filter(|b| *b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let vals: Vec<u8> = chunk.iter().map(|&b| b64_val(b)).collect::<Result<_, _>>()?;
        if vals.len() >= 2 {
            out.push((vals[0] << 2) | (vals[1] >> 4));
        }
        if vals.len() >= 3 {
            out.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if vals.len() >= 4 {
            out.push((vals[2] << 6) | vals[3]);
        }
    }
    Ok(out)
}

fn escape_json_value(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            c => result.push(c),
        }
    }
    result
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
        tracing::debug!(tool = %call.name, "executing tool");
        match call.name.as_str() {
            "echo" => Ok(ToolResult {
                output: format!("tool {} => {}", call.name, call.input),
            }),
            "read-file" => {
                let path = self.resolve_workspace_path(&call.input);
                self.security_check_path(&path)?;
                file_guard::guard_read(&path, &self.workspace_root)?;
                // Guard against reading very large files.
                if let Ok(meta) = fs::metadata(&path) {
                    if meta.len() > MAX_READ_FILE_BYTES {
                        return Err(OctoError::Runtime(format!(
                            "file {} is too large ({} bytes, limit {})",
                            path.display(),
                            meta.len(),
                            MAX_READ_FILE_BYTES
                        )));
                    }
                }
                let output = fs::read_to_string(&path).map_err(|error| {
                    OctoError::Runtime(format!("failed to read file {}: {error}", path.display()))
                })?;
                Ok(ToolResult { output: truncate_output(&output, MAX_OUTPUT_BYTES) })
            }
            "list-files" => {
                let path = self.resolve_workspace_path(if call.input.trim().is_empty() {
                    "."
                } else {
                    &call.input
                });
                self.security_check_path(&path)?;
                let entries = fs::read_dir(&path).map_err(|error| {
                    OctoError::Runtime(format!("failed to list files {}: {error}", path.display()))
                })?;
                let mut names = entries
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect::<Vec<_>>();
                names.sort();
                Ok(ToolResult {
                    output: truncate_output(&names.join("\n"), MAX_OUTPUT_BYTES),
                })
            }
            "write-file" => {
                let (_, raw_payload) = split_approval_input(&call.input);
                let (path_text, _) = raw_payload.split_once('|').ok_or_else(|| {
                    OctoError::Runtime(String::from(
                        "write-file expects input in the form path|content",
                    ))
                })?;
                let path_probe = self.resolve_workspace_path(path_text.trim());
                let effective_input = if is_high_risk_write_target(&path_probe) {
                    self.enforce_approval("write-file", &call.input, |candidate| {
                        let write_path = candidate
                            .split_once('|')
                            .map(|(value, _)| value.trim())
                            .unwrap_or_default();
                        let resolved = self.resolve_workspace_path(write_path);
                        format!("write {}", resolved.display())
                    })?
                } else {
                    String::from(raw_payload)
                };

                let (path_text, content) = effective_input.split_once('|').ok_or_else(|| {
                    OctoError::Runtime(String::from(
                        "write-file expects input in the form path|content",
                    ))
                })?;
                let path = self.resolve_workspace_path(path_text.trim());
                self.security_check_path(&path)?;
                file_guard::guard_write(&path, content.as_bytes(), &self.workspace_root)?;
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
            "shell-command" => {
                let approved = self.enforce_approval("shell-command", &call.input, |payload| {
                    format!("command '{}'", preview_for_audit(payload, 120))
                })?;
                self.run_shell(&approved)
            }
            "search-text" => self.search_text(&call.input),
            "workflow-plan" => Ok(self.workflow_plan(&call.input)),
            "agent-action" => Ok(self.agent_action(&call.input)),
            // iteration-1 tools
            "git-status" => self.git_status(),
            "git-diff" => self.git_diff(&call.input),
            "git-log" => self.git_log(&call.input),
            "file-tree" => self.file_tree(&call.input),
            "append-file" => {
                let (_, raw_payload) = split_approval_input(&call.input);
                let (path_text, _) = raw_payload.split_once('|').ok_or_else(|| {
                    OctoError::Runtime(String::from("append-file expects input: path|content"))
                })?;
                let path = self.resolve_workspace_path(path_text.trim());
                let effective_input = if is_high_risk_write_target(&path) {
                    self.enforce_approval("append-file", &call.input, |candidate| {
                        let append_path = candidate
                            .split_once('|')
                            .map(|(value, _)| value.trim())
                            .unwrap_or_default();
                        let resolved = self.resolve_workspace_path(append_path);
                        format!("append {}", resolved.display())
                    })?
                } else {
                    String::from(raw_payload)
                };
                self.append_file(&effective_input)
            }
            "http-get" => {
                let approved = self.enforce_approval("http-get", &call.input, |payload| {
                    format!("network GET '{}'", preview_for_audit(payload, 160))
                })?;
                self.http_get(&approved)
            }
            "read-context" => self.read_context(&call.input),
            // iteration-2 tools
            "create-file" => {
                let (_, raw_payload) = split_approval_input(&call.input);
                let (path_text, _) = raw_payload.split_once('|').unwrap_or((raw_payload, ""));
                let path_probe = self.resolve_workspace_path(path_text.trim());
                let effective_input = if is_high_risk_write_target(&path_probe) {
                    self.enforce_approval("create-file", &call.input, |candidate| {
                        let create_path = candidate
                            .split_once('|')
                            .map(|(value, _)| value.trim())
                            .unwrap_or_default();
                        let resolved = self.resolve_workspace_path(create_path);
                        format!("create {}", resolved.display())
                    })?
                } else {
                    String::from(raw_payload)
                };

                let (path_text, content) = effective_input
                    .split_once('|')
                    .unwrap_or((effective_input.as_str(), ""));
                let path = self.resolve_workspace_path(path_text.trim());
                self.security_check_path(&path)?;
                file_guard::guard_write(&path, content.as_bytes(), &self.workspace_root)?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|e| OctoError::Runtime(format!("mkdir: {e}")))?;
                }
                fs::write(&path, content).map_err(|e| OctoError::Runtime(format!("create-file: {e}")))?;
                Ok(ToolResult { output: format!("created {}", path.display()) })
            }
            "delete-file" => {
                let approved = self.enforce_approval("delete-file", &call.input, |payload| {
                    let resolved = self.resolve_workspace_path(payload.trim());
                    format!("delete {}", resolved.display())
                })?;
                let path = self.resolve_workspace_path(approved.trim());
                self.security_check_path(&path)?;
                fs::remove_file(&path).map_err(|e| OctoError::Runtime(format!("delete-file: {e}")))?;
                Ok(ToolResult { output: format!("deleted {}", path.display()) })
            }
            "move-file" => {
                let approved = self.enforce_approval("move-file", &call.input, |payload| {
                    if let Some((src_text, dst_text)) = payload.split_once('|') {
                        let src = self.resolve_workspace_path(src_text.trim());
                        let dst = self.resolve_workspace_path(dst_text.trim());
                        format!("move {} -> {}", src.display(), dst.display())
                    } else {
                        String::from("move <invalid payload>")
                    }
                })?;
                let (src_text, dst_text) = approved.split_once('|').ok_or_else(|| {
                    OctoError::Runtime(String::from("move-file expects src|dst"))
                })?;
                let src = self.resolve_workspace_path(src_text.trim());
                let dst = self.resolve_workspace_path(dst_text.trim());
                self.security_check_path(&src)?;
                self.security_check_path(&dst)?;
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| OctoError::Runtime(format!("mkdir: {e}")))?;
                }
                fs::rename(&src, &dst).map_err(|e| OctoError::Runtime(format!("move-file: {e}")))?;
                Ok(ToolResult { output: format!("moved {} -> {}", src.display(), dst.display()) })
            }
            "task-submit" => {
                // Self-contained: record a TASK_SUBMIT line in the session via input
                // input format: "label" or "kind:label"
                let label = call.input.trim();
                Ok(ToolResult { output: format!("task-submit: queued '{label}' (use POST /api/tasks to persist)") })
            }
            "task-list" => {
                Ok(ToolResult { output: String::from("task-list: use GET /api/tasks?session=<id> to list tasks") })
            }
            // iteration-3 tool integrations
            "web-browse" => {
                let approved = self.enforce_approval("web-browse", &call.input, |payload| {
                    format!("network browse '{}'", preview_for_audit(payload, 160))
                })?;
                self.web_browse(&approved)
            }
            "cli-pipe" => {
                let approved = self.enforce_approval("cli-pipe", &call.input, |payload| {
                    format!("pipeline '{}'", preview_for_audit(payload, 120))
                })?;
                self.cli_pipe(&approved)
            }
            "cargo-eval" => {
                let approved = self.enforce_approval("cargo-eval", &call.input, |payload| {
                    format!("cargo eval '{}'", preview_for_audit(payload, 120))
                })?;
                self.cargo_eval(&approved)
            }
            "patch-file" => {
                let (_, raw_payload) = split_approval_input(&call.input);
                let segments: Vec<&str> = raw_payload.splitn(3, '|').collect();
                let effective_input = if segments.len() >= 3 {
                    let path_probe = self.resolve_workspace_path(segments[2].trim());
                    if is_high_risk_write_target(&path_probe) {
                        self.enforce_approval("patch-file", &call.input, |candidate| {
                            let parts: Vec<&str> = candidate.splitn(3, '|').collect();
                            if parts.len() >= 3 {
                                let resolved = self.resolve_workspace_path(parts[2].trim());
                                format!("patch {}", resolved.display())
                            } else {
                                String::from("patch <invalid payload>")
                            }
                        })?
                    } else {
                        String::from(raw_payload)
                    }
                } else {
                    String::from(raw_payload)
                };
                self.patch_file(&effective_input)
            }
            "diagnostics" => self.diagnostics(),
            // iteration-4 utility tools
            "http-post" => {
                let approved = self.enforce_approval("http-post", &call.input, |payload| {
                    format!("network POST '{}'", preview_for_audit(payload, 160))
                })?;
                self.http_post(&approved)
            }
            "json-query" => self.json_query(&call.input),
            "process-list" => self.process_list(&call.input),
            "env-var" => self.env_var(&call.input),
            "base64" => self.base64_tool(&call.input),
            // LinkMind integration tools
            "vector-search" => {
                let approved = self.enforce_approval("vector-search", &call.input, |payload| {
                    format!("network vector-search '{}'", preview_for_audit(payload, 120))
                })?;
                self.vector_search(&approved)
            }
            "vector-upsert" => {
                let approved = self.enforce_approval("vector-upsert", &call.input, |payload| {
                    format!("network vector-upsert '{}'", preview_for_audit(payload, 120))
                })?;
                self.vector_upsert(&approved)
            }
            // coordinator tools
            "team-create" => self.team_create(&call.input),
            "team-list" => self.team_list(),
            "team-delete" => self.team_delete(&call.input),
            "agent-message" => self.agent_message(&call.input),
            "team-status" => self.team_status(&call.input),
            // todo tools
            "todo-add" => self.todo_add(&call.input),
            "todo-list" => self.todo_list(),
            "todo-done" => self.todo_done(&call.input),
            // task lifecycle
            "task-get" => self.task_get(&call.input),
            // web search
            "web-search" => {
                let approved = self.enforce_approval("web-search", &call.input, |payload| {
                    format!("network web-search '{}'", preview_for_audit(payload, 120))
                })?;
                self.web_search(&approved)
            }
            // cost tracking
            "cost-summary" => Ok(ToolResult { output: String::from("cost-summary: use runtime.cost_tracker.summary()") }),
            // memory tools
            "memory-save" => {
                let parts: Vec<&str> = call.input.splitn(3, '|').collect();
                if parts.len() < 3 {
                    return Err(OctoError::Runtime(String::from("memory-save requires scope|id|content")));
                }
                let scope = match parts[0].trim() {
                    "user" => crate::memory::MemoryScope::User,
                    _ => crate::memory::MemoryScope::Project,
                };
                let config_home = crate::config::default_config_home();
                let store = crate::memory::MemoryStore::new(
                    self.workspace_root.to_str().unwrap_or("."),
                    &config_home,
                );
                let path = store.save(scope, parts[1].trim(), parts[2])?;
                Ok(ToolResult { output: format!("saved memory to {}", path.display()) })
            }
            "memory-read" => {
                let parts: Vec<&str> = call.input.splitn(2, '|').collect();
                if parts.len() < 2 {
                    return Err(OctoError::Runtime(String::from("memory-read requires scope|id")));
                }
                let scope = match parts[0].trim() {
                    "user" => crate::memory::MemoryScope::User,
                    _ => crate::memory::MemoryScope::Project,
                };
                let config_home = crate::config::default_config_home();
                let store = crate::memory::MemoryStore::new(
                    self.workspace_root.to_str().unwrap_or("."),
                    &config_home,
                );
                match store.read(scope, parts[1].trim())? {
                    Some(entry) => Ok(ToolResult { output: entry.content }),
                    None => Ok(ToolResult { output: String::from("(memory not found)") }),
                }
            }
            "memory-list" => {
                let scope = match call.input.trim() {
                    "user" => crate::memory::MemoryScope::User,
                    _ => crate::memory::MemoryScope::Project,
                };
                let config_home = crate::config::default_config_home();
                let store = crate::memory::MemoryStore::new(
                    self.workspace_root.to_str().unwrap_or("."),
                    &config_home,
                );
                let entries = store.list(scope)?;
                if entries.is_empty() {
                    Ok(ToolResult { output: String::from("(no memories)") })
                } else {
                    let listing = entries.iter()
                        .map(|e| format!("- {} ({} chars)", e.id, e.content.len()))
                        .collect::<Vec<_>>()
                        .join("\n");
                    Ok(ToolResult { output: listing })
                }
            }
            "memory-search" => {
                let config_home = crate::config::default_config_home();
                let store = crate::memory::MemoryStore::new(
                    self.workspace_root.to_str().unwrap_or("."),
                    &config_home,
                );
                let results = store.search(call.input.trim())?;
                if results.is_empty() {
                    Ok(ToolResult { output: String::from("(no matches)") })
                } else {
                    let listing = results.iter()
                        .map(|e| format!("- [{}] {}", e.id, truncate_output(&e.content, 200)))
                        .collect::<Vec<_>>()
                        .join("\n");
                    Ok(ToolResult { output: listing })
                }
            }
            "memory-delete" => {
                let parts: Vec<&str> = call.input.splitn(2, '|').collect();
                if parts.len() < 2 {
                    return Err(OctoError::Runtime(String::from("memory-delete requires scope|id")));
                }
                let scope = match parts[0].trim() {
                    "user" => crate::memory::MemoryScope::User,
                    _ => crate::memory::MemoryScope::Project,
                };
                let config_home = crate::config::default_config_home();
                let store = crate::memory::MemoryStore::new(
                    self.workspace_root.to_str().unwrap_or("."),
                    &config_home,
                );
                let deleted = store.delete(scope, parts[1].trim())?;
                Ok(ToolResult {
                    output: if deleted { String::from("deleted") } else { String::from("not found") },
                })
            }
            // sub-agent tools
            "subagent-spawn" => {
                let manager = crate::subagent::SubAgentManager::default();
                let id = manager.spawn(call.input.trim())?;
                Ok(ToolResult { output: format!("spawned sub-agent: {id}") })
            }
            "subagent-status" => {
                let manager = crate::subagent::SubAgentManager::default();
                match manager.status(call.input.trim()) {
                    Some(task) => Ok(ToolResult {
                        output: format!(
                            "id={} state={:?} goal={}",
                            task.id, task.state, task.goal
                        ),
                    }),
                    None => Ok(ToolResult { output: String::from("sub-agent not found") }),
                }
            }
            "subagent-list" => {
                let manager = crate::subagent::SubAgentManager::default();
                Ok(ToolResult { output: manager.summary() })
            }
            _ => Err(OctoError::Runtime(format!("unknown tool: {}", call.name))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_guard::MAX_WRITE_SIZE;
    use std::io::Write;

    fn extract_approval_token(message: &str) -> Option<String> {
        let marker = "__approve:";
        let start = message.find(marker)?;
        let rest = &message[start + marker.len()..];
        let token = rest.split('|').next()?.trim();
        if token.is_empty() {
            return None;
        }
        Some(String::from(token))
    }

    fn test_executor() -> WorkspaceToolExecutor {
        WorkspaceToolExecutor::new(".")
    }

    fn test_executor_for(root: &Path) -> WorkspaceToolExecutor {
        WorkspaceToolExecutor::new(root)
    }

    #[test]
    fn base64_encode_decode_roundtrip() {
        let original = "Hello, OctoCode! 你好世界";
        let encoded = base64_encode(original.as_bytes());
        let decoded = base64_decode(&encoded).unwrap();
        let result = String::from_utf8(decoded).unwrap();
        assert_eq!(result, original);
    }

    #[test]
    fn base64_encode_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_encode_padding() {
        // "A" => "QQ=="
        assert_eq!(base64_encode(b"A"), "QQ==");
        // "AB" => "QUI="
        assert_eq!(base64_encode(b"AB"), "QUI=");
        // "ABC" => "QUJD"
        assert_eq!(base64_encode(b"ABC"), "QUJD");
    }

    #[test]
    fn base64_tool_encode() {
        let exec = test_executor();
        let result = exec.base64_tool("encode|Hello World").unwrap();
        assert_eq!(result.output, "SGVsbG8gV29ybGQ=");
    }

    #[test]
    fn base64_tool_decode() {
        let exec = test_executor();
        let result = exec.base64_tool("decode|SGVsbG8gV29ybGQ=").unwrap();
        assert_eq!(result.output, "Hello World");
    }

    #[test]
    fn env_var_reads_path() {
        let exec = test_executor();
        let result = exec.env_var("PATH").unwrap();
        assert!(!result.output.is_empty());
        assert!(!result.output.starts_with("(not set"));
    }

    #[test]
    fn env_var_nonexistent() {
        let exec = test_executor();
        let result = exec.env_var("ZCXWQE_NONEXISTENT_VAR_12345").unwrap();
        assert!(result.output.contains("not set"));
    }

    #[test]
    fn env_var_rejects_special_chars() {
        let exec = test_executor();
        let result = exec.env_var("FOO;BAR");
        assert!(result.is_err());
    }

    #[test]
    fn tool_catalog_has_43_tools() {
        let catalog = RuntimeToolCatalog;
        let descriptors = catalog.descriptors();
        assert_eq!(descriptors.len(), 51, "expected 51 tool descriptors, got {}", descriptors.len());
    }

    #[test]
    fn unknown_tool_returns_error() {
        let exec = test_executor();
        let call = ToolCall {
            name: String::from("nonexistent-tool"),
            input: String::new(),
            permission: PermissionMode::ReadOnly,
        };
        let result = exec.execute(call);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unknown tool"));
    }

    #[test]
    fn web_browse_rejects_ftp() {
        let exec = test_executor();
        let result = exec.web_browse("ftp://example.com");
        assert!(result.is_err());
    }

    #[test]
    fn http_post_rejects_ftp() {
        let exec = test_executor();
        let result = exec.http_post("ftp://x|body");
        assert!(result.is_err());
    }

    #[test]
    fn cargo_eval_rejects_invalid_action() {
        let exec = test_executor();
        let result = exec.cargo_eval("run|.");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("check"));
    }

    #[test]
    fn patch_file_wrong_format() {
        let exec = test_executor();
        let result = exec.patch_file("only_one_segment");
        assert!(result.is_err());
    }

    #[test]
    fn cli_pipe_empty_rejects() {
        let exec = test_executor();
        let result = exec.cli_pipe("");
        assert!(result.is_err());
    }

    #[test]
    fn read_file_rejects_binary_content() {
        let root = std::env::temp_dir().join(format!("octocode-tools-binary-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        let file = root.join("binary.bin");
        let mut handle = fs::File::create(&file).expect("create binary file");
        handle
            .write_all(&[0x89, 0x50, 0x4E, 0x47, 0x00, 0x01])
            .expect("write binary bytes");

        let exec = test_executor_for(&root);
        let result = exec.execute(ToolCall {
            name: String::from("read-file"),
            input: String::from("binary.bin"),
            permission: PermissionMode::ReadOnly,
        });

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("appears to be a binary file"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_file_rejects_oversized_content() {
        let root = std::env::temp_dir().join(format!("octocode-tools-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");

        let exec = test_executor_for(&root);
        let content = "a".repeat((MAX_WRITE_SIZE as usize) + 1);
        let result = exec.execute(ToolCall {
            name: String::from("write-file"),
            input: format!("large.txt|{content}"),
            permission: PermissionMode::WorkspaceWrite,
        });

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exceeds write limit"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn shell_command_requires_approval_then_executes_with_token() {
        let exec = test_executor();
        let denied = exec.execute(ToolCall {
            name: String::from("shell-command"),
            input: String::from("echo approval-check"),
            permission: PermissionMode::DangerFullAccess,
        });

        assert!(denied.is_err());
        let err_text = denied.unwrap_err().to_string();
        assert!(err_text.contains("approval required"));
        let token = extract_approval_token(&err_text).expect("approval token in error message");

        let approved = exec
            .execute(ToolCall {
                name: String::from("shell-command"),
                input: format!("__approve:{token}|echo approval-check"),
                permission: PermissionMode::DangerFullAccess,
            })
            .expect("shell command with approval token should run");
        assert!(approved.output.to_ascii_lowercase().contains("approval-check"));
    }

    #[test]
    fn delete_file_requires_approval_token() {
        let root = std::env::temp_dir().join(format!("octocode-tools-delete-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        let file = root.join("delete_me.txt");
        fs::write(&file, "payload").expect("seed test file");

        let exec = test_executor_for(&root);
        let denied = exec.execute(ToolCall {
            name: String::from("delete-file"),
            input: String::from("delete_me.txt"),
            permission: PermissionMode::WorkspaceWrite,
        });

        assert!(denied.is_err());
        let err_text = denied.unwrap_err().to_string();
        assert!(err_text.contains("approval required"));
        assert!(file.exists());

        let token = extract_approval_token(&err_text).expect("approval token in delete error message");
        let approved = exec.execute(ToolCall {
            name: String::from("delete-file"),
            input: format!("__approve:{token}|delete_me.txt"),
            permission: PermissionMode::WorkspaceWrite,
        });

        assert!(approved.is_ok());
        assert!(!file.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_sensitive_file_requires_approval_token() {
        let root = std::env::temp_dir().join(format!("octocode-tools-sensitive-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");

        let exec = test_executor_for(&root);
        let denied = exec.execute(ToolCall {
            name: String::from("write-file"),
            input: String::from(".env|SECRET=1"),
            permission: PermissionMode::WorkspaceWrite,
        });
        assert!(denied.is_err());

        let err_text = denied.unwrap_err().to_string();
        assert!(err_text.contains("approval required"));
        let token = extract_approval_token(&err_text).expect("approval token in write error message");

        let approved = exec.execute(ToolCall {
            name: String::from("write-file"),
            input: format!("__approve:{token}|.env|SECRET=1"),
            permission: PermissionMode::WorkspaceWrite,
        });

        assert!(approved.is_ok());
        let env_path = root.join(".env");
        assert!(env_path.exists());
        let _ = fs::remove_dir_all(&root);
    }
}

fn approval_tokens() -> &'static Mutex<HashMap<String, String>> {
    APPROVAL_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn split_approval_input(input: &str) -> (Option<&str>, &str) {
    let Some(rest) = input.strip_prefix(APPROVAL_INPUT_PREFIX) else {
        return (None, input);
    };
    let Some((token, payload)) = rest.split_once('|') else {
        return (None, input);
    };
    let token = token.trim();
    if token.is_empty() {
        return (None, input);
    }
    (Some(token), payload)
}

fn approval_key(tool_name: &str, payload: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    payload.hash(&mut hasher);
    format!("{tool_name}:{}", hasher.finish())
}

fn preview_for_audit(value: &str, max_chars: usize) -> String {
    let collapsed = value
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string();
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut out = collapsed.chars().take(max_chars).collect::<String>();
    out.push_str(" ...");
    out
}

fn is_high_risk_write_target(path: &Path) -> bool {
    let lowered_path = path.to_string_lossy().to_ascii_lowercase();

    if lowered_path.contains("/.git/")
        || lowered_path.contains("\\.git\\")
        || lowered_path.ends_with("/.git")
        || lowered_path.ends_with("\\.git")
        || lowered_path.contains("/.ssh/")
        || lowered_path.contains("\\.ssh\\")
    {
        return true;
    }

    let sensitive_names = [
        ".env",
        ".env.local",
        ".env.production",
        "authorized_keys",
        "id_rsa",
        "id_ed25519",
        "cargo.toml",
        "package.json",
        "pyproject.toml",
        "settings.json",
    ];
    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
        let lowered_name = file_name.to_ascii_lowercase();
        if sensitive_names.contains(&lowered_name.as_str()) {
            return true;
        }
    }

    let risky_exts = [
        "exe", "dll", "so", "dylib", "bat", "cmd", "ps1", "sh", "msi", "com", "scr",
        "jar",
    ];
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        let lowered_ext = ext.to_ascii_lowercase();
        if risky_exts.contains(&lowered_ext.as_str()) {
            return true;
        }
    }

    false
}