#![allow(clippy::items_after_test_module)]

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

/// Strip HTML tags, decode the common entities, and collapse whitespace so
/// the agent receives readable text instead of raw markup. Intentionally
/// dependency-free; avoids pulling a full HTML parser into the runtime.
pub(crate) fn html_to_text(html: &str) -> String {
    // Drop <script>, <style>, and <head> blocks (body content only).
    let re_block = |tag: &str, src: &str| -> String {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let mut out = String::with_capacity(src.len());
        let mut cursor = 0;
        let lower = src.to_ascii_lowercase();
        while let Some(start) = lower[cursor..].find(&open) {
            let abs = cursor + start;
            out.push_str(&src[cursor..abs]);
            if let Some(end_rel) = lower[abs..].find(&close) {
                cursor = abs + end_rel + close.len();
            } else {
                cursor = src.len();
                break;
            }
        }
        out.push_str(&src[cursor..]);
        out
    };
    let mut s = html.to_string();
    for tag in ["script", "style", "head", "noscript", "svg"] {
        s = re_block(tag, &s);
    }
    // Convert paragraph / heading / list tags to newlines for legibility.
    for tag in [
        "</p>", "</div>", "</li>", "</tr>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>",
        "<br>", "<br/>", "<br />", "</br>",
    ] {
        s = s.replace(tag, "\n");
    }
    // Strip remaining tags via a tiny state machine.
    let mut buf = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => buf.push(ch),
            _ => {}
        }
    }
    // Decode a small entity set that covers 99% of plain content.
    let decoded = buf
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    // Collapse runs of blank lines / trailing spaces.
    let mut cleaned = String::with_capacity(decoded.len());
    let mut prev_blank = false;
    for line in decoded.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            if !prev_blank {
                cleaned.push('\n');
            }
            prev_blank = true;
        } else {
            cleaned.push_str(trimmed);
            cleaned.push('\n');
            prev_blank = false;
        }
    }
    cleaned
}

pub(crate) fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let gt = lower[start..].find('>')? + start + 1;
    let end_rel = lower[gt..].find("</title>")?;
    Some(html[gt..gt + end_rel].trim().to_string())
}

/// Best-effort readability: keep the <article>/<main> slice if present,
/// otherwise fall back to the full body through `html_to_text`.
pub(crate) fn html_extract_readable(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    for tag in ["article", "main"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        if let Some(s) = lower.find(&open) {
            // Skip past the opening-tag attributes to the '>'.
            if let Some(gt) = lower[s..].find('>') {
                let body_start = s + gt + 1;
                if let Some(e_rel) = lower[body_start..].find(&close) {
                    let slice = &html[body_start..body_start + e_rel];
                    return html_to_text(slice);
                }
            }
        }
    }
    html_to_text(html)
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
        name: "empty-recycle-bin",
        summary: "Empty the OS recycle bin / trash (approval-gated, DangerFullAccess)",
        minimum_permission: PermissionMode::DangerFullAccess,
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
        summary: "Search the web (multi-engine fallback: Bing, Baidu, DuckDuckGo, Searx) — auto-skips CAPTCHA / bot-wall and returns structured title/url/snippet",
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
    // ── P0 additions (2026-04): fill Claude-Code tool-coverage gaps ─────────
    ToolDescriptor {
        name: "glob-files",
        summary: "Find files by glob pattern (supports *, **, ?); input 'pattern' or 'pattern|base_dir'",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "sleep",
        summary: "Sleep for N milliseconds (max 30000). Input: integer ms.",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "ask-user-question",
        summary: "Record a question for the user (visible via events channel). Input: question text.",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "worktree-enter",
        summary: "Create a git worktree at a given path from a branch. Input: 'path|branch'",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "worktree-exit",
        summary: "Remove a git worktree at a given path. Input: 'path' (absolute or workspace-relative)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "notebook-edit",
        summary: "Edit a Jupyter .ipynb cell by index. Input: 'path|cell_index|new_source'",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "lsp-hover",
        summary: "Spawn an LSP server (stdio) and query hover at path:line:col. Input: 'server_cmd|path|line|col'",
        minimum_permission: PermissionMode::ReadOnly,
    },
    // ── P1 additions (2026-04): Claude-Code / VS Code parity tools ─────────
    ToolDescriptor {
        name: "read-file-lines",
        summary: "Read a line range from a workspace file (1-based inclusive). Input: 'path|start|end'",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "multi-edit",
        summary: "Apply several ordered search-and-replace edits to a single file. Input: 'path|old1<<|>>new1||old2<<|>>new2||...'",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "get-errors",
        summary: "Run the workspace compiler/linter and return structured errors. Input: 'cargo' | 'clippy' | 'tsc' | 'eslint' (default: auto-detect)",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "git-commit",
        summary: "git add -A && git commit -m <message>. Input: commit message text.",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "git-branch",
        summary: "Manage git branches. Input: 'list' | 'current' | 'create <name>' | 'switch <name>' | 'delete <name>'",
        minimum_permission: PermissionMode::WorkspaceWrite,
    },
    ToolDescriptor {
        name: "fetch-readable",
        summary: "Fetch a URL and extract readable article text (strips nav/ads/script). Input: url",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "html-to-markdown",
        summary: "Convert an HTML string to plain markdown-ish text (strips tags, decodes entities). Input: raw HTML",
        minimum_permission: PermissionMode::ReadOnly,
    },
    ToolDescriptor {
        name: "run-task",
        summary: "Run a common build/test task with streaming output. Input: 'cargo-build' | 'cargo-test' | 'npm-test' | 'npm-build' | 'pytest' | 'pnpm-test' | or 'custom|<shell>'",
        minimum_permission: PermissionMode::WorkspaceWrite,
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

    pub(crate) fn execute_shell_command(&self, command_line: &str) -> Result<ToolResult, OctoError> {
        self.run_shell(command_line)
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
                concat!(
                    "$rg = Get-Command rg -ErrorAction SilentlyContinue; ",
                    "if ($rg) {{ ",
                    "& $rg.Source --line-number --no-heading --color never --max-count 50 ",
                    "--glob '!target/**' --glob '!node_modules/**' --glob '!.git/**' --glob '!build/**' ",
                    "-- '{}' '{}'; ",
                    "}} else {{ ",
                    "Get-ChildItem -Path '{}' -Recurse -File -ErrorAction SilentlyContinue | ",
                    "Where-Object {{ $_.FullName -notmatch '\\\\(target|node_modules|\\.git|build)\\\\' }} | ",
                    "Select-String -Pattern '{}' | Select-Object -First 50 | ",
                    "ForEach-Object {{ \"{{0}}:{{1}}:{{2}}\" -f $_.Path, $_.LineNumber, $_.Line.Trim() }} ",
                    "}}"
                ),
                pattern,
                location,
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
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(OctoError::Runtime(String::from("http-get only supports http/https")));
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(20))
            .build();
        let resp = agent
            .get(url)
            .set(
                "User-Agent",
                "OctocodeBot/1.0 (+https://github.com/octocode)",
            )
            .set("Accept", "text/html,text/plain,application/json;q=0.9,*/*;q=0.1")
            .call()
            .map_err(|e| OctoError::Runtime(format!("http-get failed: {e}")))?;
        let status = resp.status();
        let content_type = resp.header("content-type").unwrap_or("").to_string();
        let body = resp
            .into_string()
            .map_err(|e| OctoError::Runtime(format!("http-get read: {e}")))?;
        let output = format!(
            "HTTP {} {}\n{}",
            status,
            content_type,
            truncate_output(&body, 32 * 1024)
        );
        Ok(ToolResult { output })
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
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(25))
            .build();
        let resp = agent
            .get(url)
            .set(
                "User-Agent",
                "Mozilla/5.0 (compatible; OctocodeBot/1.0; +https://github.com/octocode)",
            )
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .call()
            .map_err(|e| OctoError::Runtime(format!("web-browse failed: {e}")))?;
        let status = resp.status();
        let content_type = resp.header("content-type").unwrap_or("").to_string();
        let body = resp
            .into_string()
            .map_err(|e| OctoError::Runtime(format!("web-browse read: {e}")))?;
        let text = if content_type.contains("html") || body.contains("<html") || body.contains("<body") {
            html_to_text(&body)
        } else {
            body
        };
        let output = format!(
            "HTTP {} {}\nURL {}\n\n{}",
            status,
            content_type,
            url,
            truncate_output(&text, 32 * 1024)
        );
        Ok(ToolResult { output })
    }

    fn fetch_readable(&self, input: &str) -> Result<ToolResult, OctoError> {
        let url = input.trim();
        if url.is_empty() {
            return Err(OctoError::Runtime(String::from("fetch-readable requires a URL")));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(OctoError::Runtime(String::from(
                "fetch-readable only supports http/https",
            )));
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(25))
            .build();
        let resp = agent
            .get(url)
            .set(
                "User-Agent",
                "Mozilla/5.0 (compatible; OctocodeBot/1.0; +https://github.com/octocode)",
            )
            .set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
            .call()
            .map_err(|e| OctoError::Runtime(format!("fetch-readable failed: {e}")))?;
        let body = resp
            .into_string()
            .map_err(|e| OctoError::Runtime(format!("fetch-readable read: {e}")))?;
        let title = extract_html_title(&body).unwrap_or_default();
        let readable = html_extract_readable(&body);
        let mut out = String::new();
        if !title.is_empty() {
            out.push_str(&format!("# {}\n\n", title));
        }
        out.push_str(&format!("Source: {}\n\n", url));
        out.push_str(&readable);
        Ok(ToolResult {
            output: truncate_output(&out, 48 * 1024),
        })
    }

    fn html_to_markdown_tool(&self, input: &str) -> Result<ToolResult, OctoError> {
        let text = input.trim();
        if text.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "html-to-markdown requires HTML input",
            )));
        }
        let md = html_to_text(text);
        Ok(ToolResult {
            output: truncate_output(&md, MAX_OUTPUT_BYTES),
        })
    }

    fn read_file_lines(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.splitn(3, '|').collect();
        if parts.len() < 3 {
            return Err(OctoError::Runtime(String::from(
                "read-file-lines expects path|start|end (1-based inclusive)",
            )));
        }
        let path = self.resolve_workspace_path(parts[0].trim());
        self.security_check_path(&path)?;
        file_guard::guard_read(&path, &self.workspace_root)?;
        let start: usize = parts[1]
            .trim()
            .parse()
            .map_err(|_| OctoError::Runtime(String::from("start must be a positive integer")))?;
        let end: usize = parts[2]
            .trim()
            .parse()
            .map_err(|_| OctoError::Runtime(String::from("end must be a positive integer")))?;
        if start == 0 || end == 0 || end < start {
            return Err(OctoError::Runtime(String::from(
                "line range invalid (use 1-based inclusive start<=end)",
            )));
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| OctoError::Runtime(format!("read-file-lines: {e}")))?;
        let selected: Vec<String> = content
            .lines()
            .enumerate()
            .filter_map(|(i, line)| {
                let n = i + 1;
                if n >= start && n <= end {
                    Some(format!("{:>6}  {}", n, line))
                } else {
                    None
                }
            })
            .collect();
        if selected.is_empty() {
            return Ok(ToolResult {
                output: format!("(no lines in range {}..{} for {})", start, end, path.display()),
            });
        }
        Ok(ToolResult {
            output: truncate_output(&selected.join("\n"), MAX_OUTPUT_BYTES),
        })
    }

    fn multi_edit(&self, input: &str) -> Result<ToolResult, OctoError> {
        // Format: path|old1<<|>>new1||old2<<|>>new2||...
        let (path_text, rest) = input
            .split_once('|')
            .ok_or_else(|| OctoError::Runtime(String::from("multi-edit expects path|edits")))?;
        let path = self.resolve_workspace_path(path_text.trim());
        self.security_check_path(&path)?;
        if !path.is_file() {
            return Err(OctoError::Runtime(format!(
                "multi-edit: not a file: {}",
                path.display()
            )));
        }
        let original = fs::read_to_string(&path)
            .map_err(|e| OctoError::Runtime(format!("multi-edit read: {e}")))?;
        let mut current = original.clone();
        let mut applied = 0usize;
        let edits: Vec<&str> = rest.split("||").collect();
        for (i, edit) in edits.iter().enumerate() {
            if edit.trim().is_empty() {
                continue;
            }
            let (old, new) = edit.split_once("<<|>>").ok_or_else(|| {
                OctoError::Runtime(format!(
                    "multi-edit edit #{} expects old<<|>>new",
                    i + 1
                ))
            })?;
            if !current.contains(old) {
                return Err(OctoError::Runtime(format!(
                    "multi-edit edit #{} old-text not found",
                    i + 1
                )));
            }
            current = current.replacen(old, new, 1);
            applied += 1;
        }
        if applied == 0 {
            return Err(OctoError::Runtime(String::from(
                "multi-edit requires at least one edit",
            )));
        }
        file_guard::guard_write(&path, current.as_bytes(), &self.workspace_root)?;
        fs::write(&path, &current)
            .map_err(|e| OctoError::Runtime(format!("multi-edit write: {e}")))?;
        Ok(ToolResult {
            output: format!("patched {} ({} edits applied)", path.display(), applied),
        })
    }

    fn get_errors(&self, input: &str) -> Result<ToolResult, OctoError> {
        let sel = input.trim();
        let cmd = match sel {
            "" | "auto" => {
                if self.workspace_root.join("Cargo.toml").exists() {
                    "cargo check --message-format=short 2>&1"
                } else if self.workspace_root.join("tsconfig.json").exists() {
                    "npx --no-install tsc --noEmit --pretty false 2>&1"
                } else if self.workspace_root.join("package.json").exists() {
                    "npm run -s lint 2>&1"
                } else {
                    return Err(OctoError::Runtime(String::from(
                        "get-errors: cannot auto-detect (no Cargo.toml/tsconfig.json/package.json)",
                    )));
                }
            }
            "cargo" => "cargo check --message-format=short 2>&1",
            "clippy" => "cargo clippy --all-targets --message-format=short -- -D warnings 2>&1",
            "tsc" => "npx --no-install tsc --noEmit --pretty false 2>&1",
            "eslint" => "npx --no-install eslint . 2>&1",
            other => return Err(OctoError::Runtime(format!("get-errors: unknown kind '{other}'"))),
        };
        let result = self.run_shell_with_timeout(cmd, Duration::from_secs(120))?;
        // Heuristic: extract lines containing 'error' / 'warning'.
        let mut findings: Vec<&str> = result
            .output
            .lines()
            .filter(|l| {
                let lc = l.to_ascii_lowercase();
                lc.contains("error") || lc.contains("warning")
            })
            .take(200)
            .collect();
        if findings.is_empty() {
            findings.push("(no errors or warnings detected)");
        }
        let summary = format!(
            "[{}]\n{}\n\n---\nfull output:\n{}",
            sel,
            findings.join("\n"),
            truncate_output(&result.output, 32 * 1024)
        );
        Ok(ToolResult {
            output: truncate_output(&summary, MAX_OUTPUT_BYTES),
        })
    }

    fn git_commit(&self, input: &str) -> Result<ToolResult, OctoError> {
        let msg = input.trim();
        if msg.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "git-commit requires a commit message",
            )));
        }
        if msg.contains('\'') {
            return Err(OctoError::Runtime(String::from(
                "git-commit message must not contain single quotes (use --amend manually)",
            )));
        }
        let cmd = if cfg!(target_os = "windows") {
            format!(
                "git add -A; git commit -m '{}' 2>&1 | Out-String",
                msg.replace('\'', "''")
            )
        } else {
            format!("git add -A && git commit -m '{}' 2>&1", msg)
        };
        self.run_shell(&cmd)
    }

    fn git_branch(&self, input: &str) -> Result<ToolResult, OctoError> {
        let trimmed = input.trim();
        let (action, name) = match trimmed.split_once(' ') {
            Some((a, n)) => (a.trim(), n.trim()),
            None => (trimmed, ""),
        };
        let safe_name = |n: &str| -> Result<String, OctoError> {
            if n.is_empty()
                || !n
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
            {
                return Err(OctoError::Runtime(format!(
                    "git-branch: invalid branch name '{n}'"
                )));
            }
            Ok(n.to_string())
        };
        let cmd = match action {
            "" | "list" => String::from("git branch -a 2>&1"),
            "current" => String::from("git rev-parse --abbrev-ref HEAD 2>&1"),
            "create" => format!("git checkout -b {} 2>&1", safe_name(name)?),
            "switch" => format!("git checkout {} 2>&1", safe_name(name)?),
            "delete" => format!("git branch -D {} 2>&1", safe_name(name)?),
            other => {
                return Err(OctoError::Runtime(format!(
                    "git-branch: unknown action '{other}' (list|current|create|switch|delete)"
                )))
            }
        };
        self.run_shell(&cmd)
    }

    fn run_task(&self, input: &str) -> Result<ToolResult, OctoError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "run-task requires a preset name or 'custom|<shell>'",
            )));
        }
        let (preset, tail) = trimmed.split_once('|').unwrap_or((trimmed, ""));
        let cmd = match preset.trim() {
            "cargo-build" => String::from("cargo build 2>&1"),
            "cargo-test" => String::from("cargo test --workspace --lib 2>&1"),
            "cargo-check" => String::from("cargo check --workspace 2>&1"),
            "cargo-clippy" => String::from("cargo clippy --workspace --all-targets -- -D warnings 2>&1"),
            "npm-test" => String::from("npm test --silent 2>&1"),
            "npm-build" => String::from("npm run -s build 2>&1"),
            "npm-install" => String::from("npm ci --no-audit --prefer-offline 2>&1"),
            "pnpm-test" => String::from("pnpm -s test 2>&1"),
            "pnpm-build" => String::from("pnpm -s build 2>&1"),
            "pytest" => String::from("python -m pytest -q 2>&1"),
            "custom" => {
                if tail.trim().is_empty() {
                    return Err(OctoError::Runtime(String::from(
                        "run-task custom requires |<shell command>",
                    )));
                }
                tail.trim().to_string()
            }
            other => {
                return Err(OctoError::Runtime(format!(
                    "run-task: unknown preset '{other}' (cargo-build|cargo-test|cargo-check|cargo-clippy|npm-test|npm-build|npm-install|pnpm-test|pnpm-build|pytest|custom|<cmd>)"
                )))
            }
        };
        self.run_shell_with_timeout(&cmd, Duration::from_secs(300))
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

    fn empty_recycle_bin(&self, _approved: &str) -> Result<ToolResult, OctoError> {
        // Cross-platform OS recycle bin / trash emptying. Gated by the
        // approval flow in the caller; reaching here means the operator
        // explicitly confirmed. We shell out rather than calling SHEmptyRecycleBin
        // directly to avoid pulling a new winapi dep.
        let cmd = if cfg!(target_os = "windows") {
            String::from("Clear-RecycleBin -Force -ErrorAction SilentlyContinue; 'recycle bin emptied'")
        } else if cfg!(target_os = "macos") {
            String::from("osascript -e 'tell application \"Finder\" to empty trash' && echo 'trash emptied'")
        } else {
            String::from("if command -v gio >/dev/null 2>&1; then gio trash --empty && echo 'trash emptied (gio)'; else rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/* 2>/dev/null && echo 'trash emptied (fallback)'; fi")
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
    //
    // Multi-engine fallback chain with CAPTCHA / bot-wall detection. Tries
    // engines in order, skips any response that looks like a challenge, and
    // returns the first usable structured result set (title | url | snippet).
    //
    // Order: Bing HTML → Baidu → DuckDuckGo HTML → DuckDuckGo Lite →
    // SearxNG (searx.be). Each uses ureq with a realistic UA; no shell.

    fn web_search(&self, input: &str) -> Result<ToolResult, OctoError> {
        let query = input.trim();
        if query.is_empty() {
            return Err(OctoError::Runtime(String::from("web-search requires a query")));
        }
        let encoded = url_encode_query(query);
        let engines: &[(&str, String)] = &[
            ("bing", format!("https://www.bing.com/search?q={encoded}&setlang=zh-CN&ensearch=0")),
            ("baidu", format!("https://www.baidu.com/s?wd={encoded}&ie=utf-8")),
            ("ddg-html", format!("https://html.duckduckgo.com/html/?q={encoded}")),
            ("ddg-lite", format!("https://lite.duckduckgo.com/lite/?q={encoded}")),
            ("searx", format!("https://searx.be/search?q={encoded}&format=json&language=zh")),
        ];

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(8))
            .timeout_read(Duration::from_secs(12))
            .redirects(5)
            .build();

        let mut attempts: Vec<String> = Vec::new();
        for (name, url) in engines {
            match fetch_search_engine(&agent, url) {
                Ok(body) => {
                    if looks_like_bot_wall(&body) {
                        attempts.push(format!("[{name}] blocked: CAPTCHA/bot-wall detected"));
                        continue;
                    }
                    let results = match *name {
                        "bing" => parse_bing_results(&body),
                        "baidu" => parse_baidu_results(&body),
                        "ddg-html" | "ddg-lite" => parse_duckduckgo_results(&body),
                        "searx" => parse_searx_json(&body),
                        _ => Vec::new(),
                    };
                    if results.is_empty() {
                        attempts.push(format!("[{name}] no usable results parsed"));
                        continue;
                    }
                    let mut out = String::new();
                    out.push_str(&format!("web-search [{name}] q=\"{query}\"\n"));
                    out.push_str(&format!("found {} result(s)\n\n", results.len()));
                    for (i, r) in results.iter().take(10).enumerate() {
                        out.push_str(&format!(
                            "{}. {}\n   {}\n   {}\n\n",
                            i + 1,
                            r.title,
                            r.url,
                            r.snippet
                        ));
                    }
                    if !attempts.is_empty() {
                        out.push_str("(fallback chain: ");
                        out.push_str(&attempts.join(", "));
                        out.push_str(")\n");
                    }
                    // Inline next-step playbook. Snippets rarely contain the
                    // actual answer for factual queries (weather, prices,
                    // times, scores). Tell the model explicitly what to do
                    // next rather than hoping it infers.
                    out.push_str(&web_search_followup_hint(query));
                    return Ok(ToolResult {
                        output: truncate_output(&out, 16 * 1024),
                    });
                }
                Err(e) => {
                    attempts.push(format!("[{name}] transport: {e}"));
                    continue;
                }
            }
        }
        Err(OctoError::Runtime(format!(
            "web-search failed: all engines blocked or unreachable. attempts: {}",
            attempts.join(" | ")
        )))
    }
}

// ── web-search helpers ─────────────────────────────────────────────────────

/// Inline next-step playbook appended to every `web-search` result.
/// Search snippets rarely contain the actual answer for factual queries
/// (weather, prices, times, scores). Models trained on generic chat data
/// tend to stop at snippets and say "I couldn't find the answer." Tell
/// them explicitly which tool to call next.
fn web_search_followup_hint(query: &str) -> String {
    let q = query.to_lowercase();
    let mut out = String::from(
        "\n── Next step playbook ──\n\
Search snippets rarely contain the full answer. To actually answer the user, \
pick ONE of these based on the question:\n\
- Detail page: `fetch-readable(url=\"<one of the URLs above>\")` to read the target article.\n\
- Parse rendered page: `html-to-markdown(url=\"<URL>\")` when readable mode strips too much.\n\
- Public JSON API: `http-get(url=\"<api endpoint>\")` — always preferred when available.\n",
    );

    // Domain-specific recipes (Chinese + English keywords).
    if q.contains("天气") || q.contains("weather") || q.contains("气温") || q.contains("预报") {
        out.push_str(
            "\nWEATHER QUERIES — the snippets NEVER contain temperatures. Call:\n\
  http-get(url=\"https://wttr.in/<City>?format=j1&lang=zh\")    # JSON, 3-day forecast\n\
  http-get(url=\"https://wttr.in/<City>?lang=zh&T\")            # compact text\n\
Use the English romanization of the city (Jinan, Beijing, Shanghai) or the \
Chinese name URL-encoded. The JSON contains `weather[0..2]` for today+2 days, \
each with maxtempC / mintempC / hourly[].weatherDesc.\n",
        );
    }
    if q.contains("股") || q.contains("stock") || q.contains("price") || q.contains("股价") {
        out.push_str(
            "\nSTOCK/PRICE QUERIES — snippets lag. Call a JSON API:\n\
  http-get(url=\"https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>?interval=1d&range=5d\")\n",
        );
    }
    if q.contains("时间") || q.contains("time now") || q.contains("current time") {
        out.push_str(
            "\nTIME QUERIES:\n\
  http-get(url=\"https://worldtimeapi.org/api/timezone/<Area>/<Location>\")  # e.g. Asia/Shanghai\n",
        );
    }
    if q.contains("汇率") || q.contains("exchange rate") || q.contains("currency") {
        out.push_str(
            "\nEXCHANGE RATE QUERIES:\n\
  http-get(url=\"https://api.exchangerate-api.com/v4/latest/USD\")\n\
  http-get(url=\"https://open.er-api.com/v6/latest/CNY\")\n",
        );
    }

    out.push_str(
        "\nDo NOT tell the user you cannot answer before trying at least one of the above. \
If a URL above returns a bot-wall, try the next recipe or a different URL from the search results.\n",
    );
    out
}

#[derive(Debug, Clone)]
pub(crate) struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

fn url_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn fetch_search_engine(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    let resp = agent
        .get(url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        )
        .set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .call()
        .map_err(|e| e.to_string())?;
    resp.into_string().map_err(|e| e.to_string())
}

pub(crate) fn looks_like_bot_wall(body: &str) -> bool {
    if body.len() < 400 {
        return true;
    }
    let lower = body.to_ascii_lowercase();
    let markers = [
        "select all squares",
        "confirm this search was made by a human",
        "captcha",
        "are you a robot",
        "unusual traffic",
        "请完成安全验证",
        "百度安全验证",
        "网络不给力",
        "access denied",
        "bot detection",
        "cf-challenge",
        "challenge-platform",
    ];
    markers.iter().any(|m| lower.contains(m))
}

/// Extract anchor blocks from HTML and apply a mapper to (href, inner_text_range).
fn parse_bing_results(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    // Bing result cards: <li class="b_algo"><h2><a href="URL">TITLE</a></h2>
    //                   <div class="b_caption"><p>SNIPPET</p></div></li>
    let re_item = regex_finditer(html, "<li class=\"b_algo\"", "</li>");
    for block in re_item {
        let href = extract_attr(block, "<a", "href=\"").unwrap_or_default();
        if href.is_empty() || !href.starts_with("http") {
            continue;
        }
        let title = extract_between(block, "<h2>", "</h2>")
            .map(|s| strip_tags(&s))
            .unwrap_or_default();
        let snippet = extract_between(block, "<p", "</p>")
            .map(|s| {
                let inner_start = s.find('>').map(|i| i + 1).unwrap_or(0);
                strip_tags(&s[inner_start..])
            })
            .unwrap_or_default();
        if !title.is_empty() {
            hits.push(SearchHit { title, url: href, snippet });
        }
    }
    hits
}

fn parse_baidu_results(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    // Baidu result cards: <div class="result..."> ... <a href="..." ...>TITLE</a>
    //                    <span ... class="content-right_...">SNIPPET</span>
    let blocks = regex_finditer(html, "<div class=\"result", "</div>");
    for block in blocks {
        let href = extract_attr(block, "<a", "href=\"").unwrap_or_default();
        if href.is_empty() || !href.starts_with("http") {
            continue;
        }
        let title = extract_between(block, "<a", "</a>")
            .map(|s| {
                let inner_start = s.find('>').map(|i| i + 1).unwrap_or(0);
                strip_tags(&s[inner_start..])
            })
            .unwrap_or_default();
        let snippet = extract_between(block, "content-right", "</span>")
            .map(|s| {
                let inner_start = s.find('>').map(|i| i + 1).unwrap_or(0);
                strip_tags(&s[inner_start..])
            })
            .unwrap_or_default();
        if !title.is_empty() && title.len() > 3 {
            hits.push(SearchHit { title, url: href, snippet });
        }
    }
    hits
}

fn parse_duckduckgo_results(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    // DDG HTML: <a class="result__a" href="URL">TITLE</a>
    //           <a class="result__snippet">SNIPPET</a>
    let mut cursor = 0usize;
    while let Some(start) = html[cursor..].find("class=\"result__a\"") {
        let abs = cursor + start;
        let href = extract_attr(&html[abs.saturating_sub(200)..abs + 100], "<a", "href=\"")
            .unwrap_or_default();
        // Find closing </a>
        if let Some(close) = html[abs..].find("</a>") {
            let inner_start = html[abs..].find('>').map(|i| abs + i + 1).unwrap_or(abs);
            let title = strip_tags(&html[inner_start..abs + close]);
            let after = abs + close + 4;
            let snippet_start = html[after..]
                .find("result__snippet")
                .map(|i| after + i)
                .unwrap_or(after);
            let snippet_close = html[snippet_start..]
                .find("</a>")
                .or_else(|| html[snippet_start..].find("</div>"))
                .map(|i| snippet_start + i)
                .unwrap_or(snippet_start);
            let snippet_inner = html[snippet_start..]
                .find('>')
                .map(|i| snippet_start + i + 1)
                .unwrap_or(snippet_start);
            let snippet = if snippet_inner < snippet_close {
                strip_tags(&html[snippet_inner..snippet_close])
            } else {
                String::new()
            };
            if !href.is_empty() && !title.is_empty() {
                // DDG wraps real URL in /l/?uddg=<encoded>
                let real = if href.contains("uddg=") {
                    href.split("uddg=")
                        .nth(1)
                        .and_then(|s| s.split('&').next())
                        .map(url_decode)
                        .unwrap_or(href.clone())
                } else {
                    href.clone()
                };
                hits.push(SearchHit { title, url: real, snippet });
            }
            cursor = abs + close + 4;
        } else {
            break;
        }
    }
    hits
}

fn parse_searx_json(body: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    // Parse JSON minimally: look for {"url":"...","title":"...","content":"..."}
    // Avoid adding serde_json dependency — simple scan.
    let mut cursor = 0usize;
    while let Some(off) = body[cursor..].find("\"url\"") {
        let start = cursor + off;
        let url = extract_json_string(&body[start..], "\"url\"").unwrap_or_default();
        let title = extract_json_string(&body[start..], "\"title\"").unwrap_or_default();
        let content = extract_json_string(&body[start..], "\"content\"").unwrap_or_default();
        if !url.is_empty() && !title.is_empty() {
            hits.push(SearchHit { title, url, snippet: content });
        }
        cursor = start + 5;
        if hits.len() >= 15 {
            break;
        }
    }
    hits
}

fn regex_finditer<'a>(hay: &'a str, start_marker: &str, end_marker: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(s) = hay[cursor..].find(start_marker) {
        let s_abs = cursor + s;
        if let Some(e) = hay[s_abs..].find(end_marker) {
            let e_abs = s_abs + e + end_marker.len();
            out.push(&hay[s_abs..e_abs]);
            cursor = e_abs;
        } else {
            break;
        }
        if out.len() >= 20 {
            break;
        }
    }
    out
}

fn extract_between(hay: &str, start: &str, end: &str) -> Option<String> {
    let s = hay.find(start)?;
    let e_rel = hay[s..].find(end)?;
    Some(hay[s..s + e_rel].to_string())
}

fn extract_attr(hay: &str, tag_start: &str, attr_prefix: &str) -> Option<String> {
    let t = hay.find(tag_start)?;
    let a = hay[t..].find(attr_prefix)? + t + attr_prefix.len();
    let end = hay[a..].find('"')?;
    Some(hay[a..a + end].to_string())
}

fn extract_json_string(hay: &str, key: &str) -> Option<String> {
    let k = hay.find(key)?;
    let after = k + key.len();
    let colon = hay[after..].find(':')? + after + 1;
    // skip whitespace and opening quote
    let bytes = hay.as_bytes();
    let mut i = colon;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\n') {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'"' {
        return None;
    }
    i += 1;
    let mut out = String::new();
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some(out),
            b'\\' if i + 1 < bytes.len() => {
                match bytes[i + 1] {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'/' => out.push('/'),
                    _ => {}
                }
                i += 2;
            }
            other => {
                out.push(other as char);
                i += 1;
            }
        }
        if out.len() > 2000 {
            return Some(out);
        }
    }
    None
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    // Decode a few common entities
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
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

// ─── P0: new tool helpers ─────────────────────────────────────────────────
impl WorkspaceToolExecutor {
    /// `glob-files`: `pattern` or `pattern|base_dir`.
    /// Supports `*` (any chars in segment), `?` (one char), `**` (any depth).
    fn glob_files(&self, input: &str) -> Result<ToolResult, OctoError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "glob-files: pattern is required",
            )));
        }
        let (pattern, base_rel) = match trimmed.split_once('|') {
            Some((p, b)) => (p.trim(), b.trim()),
            None => (trimmed, "."),
        };
        let base = self.resolve_workspace_path(base_rel);
        self.security_check_path(&base)?;

        let matcher = GlobMatcher::parse(pattern);
        let mut matches = Vec::new();
        glob_walk(&base, &base, &matcher, 0, 32, &mut matches);
        matches.sort();
        if matches.len() > 500 {
            matches.truncate(500);
            matches.push(String::from("[… truncated at 500 matches]"));
        }
        Ok(ToolResult {
            output: truncate_output(&matches.join("\n"), MAX_OUTPUT_BYTES),
        })
    }

    /// `sleep`: pause for N ms (cap 30_000).
    fn sleep_ms(&self, input: &str) -> Result<ToolResult, OctoError> {
        let ms: u64 = input
            .trim()
            .parse()
            .map_err(|_| OctoError::Runtime(String::from("sleep: input must be integer ms")))?;
        let capped = ms.min(30_000);
        std::thread::sleep(Duration::from_millis(capped));
        Ok(ToolResult {
            output: format!("slept {capped}ms"),
        })
    }

    /// `worktree-enter`: `path|branch`. Creates a new git worktree.
    fn worktree_enter(&self, input: &str) -> Result<ToolResult, OctoError> {
        let (_, raw) = split_approval_input(input);
        let (path_text, branch) = raw.split_once('|').ok_or_else(|| {
            OctoError::Runtime(String::from("worktree-enter expects 'path|branch'"))
        })?;
        let path = self.resolve_workspace_path(path_text.trim());
        self.security_check_path(&path)?;
        let cmd = format!(
            "git worktree add {} {}",
            shell_quote(&path.display().to_string()),
            shell_quote(branch.trim())
        );
        self.run_shell(&cmd)
    }

    /// `worktree-exit`: `path`. Removes a git worktree.
    fn worktree_exit(&self, input: &str) -> Result<ToolResult, OctoError> {
        let (_, raw) = split_approval_input(input);
        let path = self.resolve_workspace_path(raw.trim());
        self.security_check_path(&path)?;
        let cmd = format!(
            "git worktree remove {} --force",
            shell_quote(&path.display().to_string())
        );
        self.run_shell(&cmd)
    }

    /// `notebook-edit`: `path|cell_index|new_source` — replaces a cell's source in a .ipynb file.
    fn notebook_edit(&self, input: &str) -> Result<ToolResult, OctoError> {
        let (_, raw) = split_approval_input(input);
        let parts: Vec<&str> = raw.splitn(3, '|').collect();
        if parts.len() != 3 {
            return Err(OctoError::Runtime(String::from(
                "notebook-edit expects 'path|cell_index|new_source'",
            )));
        }
        let path = self.resolve_workspace_path(parts[0].trim());
        self.security_check_path(&path)?;
        let idx: usize = parts[1].trim().parse().map_err(|_| {
            OctoError::Runtime(String::from("notebook-edit: cell_index must be integer"))
        })?;
        let new_source = parts[2];

        let raw_bytes = fs::read(&path).map_err(|e| {
            OctoError::Runtime(format!("notebook-edit: read {}: {e}", path.display()))
        })?;
        let mut nb: serde_json::Value = serde_json::from_slice(&raw_bytes).map_err(|e| {
            OctoError::Runtime(format!("notebook-edit: invalid JSON in {}: {e}", path.display()))
        })?;
        let cells = nb
            .get_mut("cells")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| OctoError::Runtime(String::from("notebook-edit: no 'cells' array")))?;
        if idx >= cells.len() {
            return Err(OctoError::Runtime(format!(
                "notebook-edit: cell_index {idx} out of range (len={})",
                cells.len()
            )));
        }
        // Convert source to ipynb-style array of lines (each line ends with \n except last).
        let lines: Vec<serde_json::Value> = if new_source.is_empty() {
            Vec::new()
        } else {
            let mut v = Vec::new();
            let mut iter = new_source.split_inclusive('\n').peekable();
            while let Some(line) = iter.next() {
                v.push(serde_json::Value::String(line.to_string()));
                let _ = iter.peek();
            }
            v
        };
        cells[idx]["source"] = serde_json::Value::Array(lines);
        // Drop execution outputs for edited code cells to avoid stale state.
        if cells[idx].get("cell_type").and_then(|v| v.as_str()) == Some("code") {
            cells[idx]["outputs"] = serde_json::Value::Array(Vec::new());
            cells[idx]["execution_count"] = serde_json::Value::Null;
        }

        let serialized = serde_json::to_vec_pretty(&nb).map_err(|e| {
            OctoError::Runtime(format!("notebook-edit: serialize: {e}"))
        })?;
        file_guard::guard_write(&path, &serialized, &self.workspace_root)?;
        fs::write(&path, &serialized).map_err(|e| {
            OctoError::Runtime(format!("notebook-edit: write {}: {e}", path.display()))
        })?;
        Ok(ToolResult {
            output: format!("edited cell {idx} in {}", path.display()),
        })
    }

    /// `lsp-hover`: minimal LSP stdio client — spawn server, initialize, send textDocument/hover.
    /// Input: `server_cmd|path|line|col` (line/col are 0-based).
    fn lsp_hover(&self, input: &str) -> Result<ToolResult, OctoError> {
        let parts: Vec<&str> = input.splitn(4, '|').collect();
        if parts.len() != 4 {
            return Err(OctoError::Runtime(String::from(
                "lsp-hover expects 'server_cmd|path|line|col'",
            )));
        }
        let server_cmd = parts[0].trim();
        let path = self.resolve_workspace_path(parts[1].trim());
        self.security_check_path(&path)?;
        let line: u32 = parts[2]
            .trim()
            .parse()
            .map_err(|_| OctoError::Runtime(String::from("lsp-hover: line must be integer")))?;
        let col: u32 = parts[3]
            .trim()
            .parse()
            .map_err(|_| OctoError::Runtime(String::from("lsp-hover: col must be integer")))?;

        let uri = format!("file:///{}", path.display().to_string().replace('\\', "/"));
        let text = fs::read_to_string(&path).unwrap_or_default();
        let root_uri = format!(
            "file:///{}",
            self.workspace_root.display().to_string().replace('\\', "/")
        );
        let language_id = match path.extension().and_then(|e| e.to_str()) {
            Some("rs") => "rust",
            Some("py") => "python",
            Some("ts") => "typescript",
            Some("js") => "javascript",
            Some("go") => "go",
            _ => "plaintext",
        };

        let init = serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": {}
            }
        });
        let initialized = serde_json::json!({
            "jsonrpc":"2.0","method":"initialized","params":{}
        });
        let did_open = serde_json::json!({
            "jsonrpc":"2.0","method":"textDocument/didOpen","params":{
                "textDocument":{"uri":uri,"languageId":language_id,"version":1,"text":text}
            }
        });
        let hover = serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{
                "textDocument":{"uri":uri},
                "position":{"line":line,"character":col}
            }
        });

        let argv: Vec<&str> = server_cmd.split_whitespace().collect();
        if argv.is_empty() {
            return Err(OctoError::Runtime(String::from("lsp-hover: empty server_cmd")));
        }
        let mut cmd = Command::new(argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .current_dir(&self.workspace_root);
        let mut child = cmd.spawn().map_err(|e| {
            OctoError::Runtime(format!("lsp-hover: spawn '{server_cmd}' failed: {e}"))
        })?;
        let stdin = child.stdin.as_mut().ok_or_else(|| {
            OctoError::Runtime(String::from("lsp-hover: no stdin on LSP child"))
        })?;
        use std::io::Write;
        for msg in [&init, &initialized, &did_open, &hover] {
            let body = serde_json::to_string(msg).unwrap();
            let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
            stdin
                .write_all(framed.as_bytes())
                .map_err(|e| OctoError::Runtime(format!("lsp-hover: write: {e}")))?;
        }
        // Read LSP responses with a small timeout via wait_with_output + external timer.
        // Simpler: close stdin then read stdout for up to ~3s.
        drop(child.stdin.take());
        let start = std::time::Instant::now();
        let mut out_buf = Vec::<u8>::new();
        let mut stdout = child.stdout.take().ok_or_else(|| {
            OctoError::Runtime(String::from("lsp-hover: no stdout on LSP child"))
        })?;
        use std::io::Read;
        let mut tmp = [0u8; 4096];
        while start.elapsed() < Duration::from_secs(5) {
            match stdout.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    out_buf.extend_from_slice(&tmp[..n]);
                    if out_buf.len() > 256 * 1024 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let text_out = String::from_utf8_lossy(&out_buf).to_string();
        Ok(ToolResult {
            output: truncate_output(&text_out, MAX_OUTPUT_BYTES),
        })
    }
}

// ─── Simple glob matcher ──────────────────────────────────────────────────
struct GlobMatcher {
    segments: Vec<GlobSeg>,
}

enum GlobSeg {
    DoubleStar,
    Pattern(Vec<GlobTok>),
}

#[derive(Clone)]
enum GlobTok {
    Star,
    Question,
    Lit(String),
}

impl GlobMatcher {
    fn parse(pattern: &str) -> Self {
        let norm = pattern.replace('\\', "/");
        let mut segments = Vec::new();
        for seg in norm.split('/') {
            if seg.is_empty() {
                continue;
            }
            if seg == "**" {
                segments.push(GlobSeg::DoubleStar);
            } else {
                segments.push(GlobSeg::Pattern(Self::tokenize(seg)));
            }
        }
        GlobMatcher { segments }
    }
    fn tokenize(s: &str) -> Vec<GlobTok> {
        let mut out = Vec::new();
        let mut lit = String::new();
        for ch in s.chars() {
            match ch {
                '*' => {
                    if !lit.is_empty() {
                        out.push(GlobTok::Lit(std::mem::take(&mut lit)));
                    }
                    out.push(GlobTok::Star);
                }
                '?' => {
                    if !lit.is_empty() {
                        out.push(GlobTok::Lit(std::mem::take(&mut lit)));
                    }
                    out.push(GlobTok::Question);
                }
                c => lit.push(c),
            }
        }
        if !lit.is_empty() {
            out.push(GlobTok::Lit(lit));
        }
        out
    }
    fn match_parts(&self, parts: &[&str]) -> bool {
        Self::match_segs(&self.segments, parts)
    }
    fn match_segs(segs: &[GlobSeg], parts: &[&str]) -> bool {
        if segs.is_empty() {
            return parts.is_empty();
        }
        match &segs[0] {
            GlobSeg::DoubleStar => {
                // match zero or more path segments
                for i in 0..=parts.len() {
                    if Self::match_segs(&segs[1..], &parts[i..]) {
                        return true;
                    }
                }
                false
            }
            GlobSeg::Pattern(toks) => {
                if parts.is_empty() {
                    return false;
                }
                if Self::match_seg(toks, parts[0]) {
                    Self::match_segs(&segs[1..], &parts[1..])
                } else {
                    false
                }
            }
        }
    }
    fn match_seg(toks: &[GlobTok], name: &str) -> bool {
        let chars: Vec<char> = name.chars().collect();
        Self::match_toks(toks, &chars)
    }
    fn match_toks(toks: &[GlobTok], s: &[char]) -> bool {
        if toks.is_empty() {
            return s.is_empty();
        }
        match &toks[0] {
            GlobTok::Star => {
                for i in 0..=s.len() {
                    if Self::match_toks(&toks[1..], &s[i..]) {
                        return true;
                    }
                }
                false
            }
            GlobTok::Question => {
                if s.is_empty() {
                    false
                } else {
                    Self::match_toks(&toks[1..], &s[1..])
                }
            }
            GlobTok::Lit(lit) => {
                let lc: Vec<char> = lit.chars().collect();
                if s.len() < lc.len() {
                    return false;
                }
                for (i, ch) in lc.iter().enumerate() {
                    if s[i] != *ch {
                        return false;
                    }
                }
                Self::match_toks(&toks[1..], &s[lc.len()..])
            }
        }
    }
}

fn glob_walk(
    root: &Path,
    current: &Path,
    matcher: &GlobMatcher,
    depth: u32,
    max_depth: u32,
    out: &mut Vec<String>,
) {
    if depth > max_depth || out.len() > 600 {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip common noise
        if matches!(
            name_str.as_ref(),
            "node_modules" | "target" | ".git" | "dist" | "build"
        ) {
            continue;
        }
        let is_dir = path.is_dir();
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let parts: Vec<&str> = rel_str.split('/').filter(|p| !p.is_empty()).collect();
        if matcher.match_parts(&parts) {
            out.push(rel_str.clone());
        }
        if is_dir {
            glob_walk(root, &path, matcher, depth + 1, max_depth, out);
        }
    }
}

fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '\\' | '.' | '-' | '_' | ':'))
    {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\\\""))
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
                let (_, raw_payload) = split_approval_input(&call.input);
                let effective_input = if http_get_host_is_preapproved(raw_payload) {
                    // Public read-only data APIs (weather, time, FX, Wikipedia,
                    // etc.). Requiring approval here just burns two round-trips
                    // and derails small models, so we pre-approve them.
                    String::from(raw_payload)
                } else {
                    self.enforce_approval("http-get", &call.input, |payload| {
                        format!("network GET '{}'", preview_for_audit(payload, 160))
                    })?
                };
                self.http_get(&effective_input)
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
            "empty-recycle-bin" => {
                let approved = self.enforce_approval("empty-recycle-bin", &call.input, |_payload| {
                    String::from("OS recycle bin / trash empty")
                })?;
                self.empty_recycle_bin(&approved)
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
            // ── P0 additions ────────────────────────────────────────────────
            "glob-files" => self.glob_files(&call.input),
            "sleep" => self.sleep_ms(&call.input),
            "ask-user-question" => Ok(ToolResult {
                output: format!("[question-recorded] {}", call.input.trim()),
            }),
            "worktree-enter" => self.worktree_enter(&call.input),
            "worktree-exit" => self.worktree_exit(&call.input),
            "notebook-edit" => self.notebook_edit(&call.input),
            "lsp-hover" => self.lsp_hover(&call.input),
            // ── P1 additions ────────────────────────────────────────────────
            "read-file-lines" => self.read_file_lines(&call.input),
            "multi-edit" => {
                let (_, raw_payload) = split_approval_input(&call.input);
                let path_text = raw_payload
                    .split_once('|')
                    .map(|(p, _)| p.trim())
                    .unwrap_or("");
                let path_probe = self.resolve_workspace_path(path_text);
                let effective_input = if is_high_risk_write_target(&path_probe) {
                    self.enforce_approval("multi-edit", &call.input, |candidate| {
                        let p = candidate
                            .split_once('|')
                            .map(|(v, _)| v.trim())
                            .unwrap_or_default();
                        format!("multi-edit {}", self.resolve_workspace_path(p).display())
                    })?
                } else {
                    String::from(raw_payload)
                };
                self.multi_edit(&effective_input)
            }
            "get-errors" => {
                let approved = self.enforce_approval("get-errors", &call.input, |payload| {
                    format!("diagnostics '{}'", preview_for_audit(payload, 60))
                })?;
                self.get_errors(&approved)
            }
            "git-commit" => {
                let approved = self.enforce_approval("git-commit", &call.input, |payload| {
                    format!("git commit '{}'", preview_for_audit(payload, 120))
                })?;
                self.git_commit(&approved)
            }
            "git-branch" => {
                let approved = self.enforce_approval("git-branch", &call.input, |payload| {
                    format!("git branch '{}'", preview_for_audit(payload, 120))
                })?;
                self.git_branch(&approved)
            }
            "fetch-readable" => {
                let approved = self.enforce_approval("fetch-readable", &call.input, |payload| {
                    format!("network fetch-readable '{}'", preview_for_audit(payload, 160))
                })?;
                self.fetch_readable(&approved)
            }
            "html-to-markdown" => self.html_to_markdown_tool(&call.input),
            "run-task" => {
                let approved = self.enforce_approval("run-task", &call.input, |payload| {
                    format!("run-task '{}'", preview_for_audit(payload, 120))
                })?;
                self.run_task(&approved)
            }
            _ => Err(OctoError::Runtime(format!("unknown tool: {}", call.name))),
        }
    }
}

/// P8-D: Defensive scanner that detects when a model emitted a tool call as
/// plain text (e.g. `<|tool_call|>tool-web-search(query="…")<tool_call|>`)
/// instead of a structured `tool_calls` payload. Returning `Some` lets the
/// runtime surface a *blocked* tool attempt to the user rather than silently
/// treating the marker as prose.
///
/// This is a stop-gap until every provider is fronted by the `cli-proxy-api`
/// translator (see `skills/cli-proxy-api-bridge/SKILL.md`). When that lands,
/// this scanner should still run as a belt-and-suspenders guard.
pub fn scan_text_tool_call(text: &str) -> Option<(String, String)> {
    // Look for any of the common text markers used by OSS models.
    const OPEN_MARKERS: &[&str] = &[
        "<|tool_call|>",
        "<|tool_calls_begin|>",
        "<|python_tag|>",
        "<tool_call>",
    ];
    let mut found_at = None;
    for marker in OPEN_MARKERS {
        if let Some(idx) = text.find(marker) {
            found_at = Some(idx + marker.len());
            break;
        }
    }
    let start = found_at?;
    let rest = &text[start..];
    // Extract name up to `(` if present, otherwise up to whitespace.
    let name_end = rest
        .find(|c: char| c == '(' || c.is_whitespace() || c == '\n')
        .unwrap_or(rest.len().min(128));
    let name = rest[..name_end].trim().to_string();
    if name.is_empty() {
        return None;
    }
    // Extract everything between the first `(` and matching `)` as raw args.
    let args = if let Some(open) = rest.find('(') {
        rest[open + 1..]
            .find(')')
            .map(|close| rest[open + 1..open + 1 + close].to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };
    Some((name, args))
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
    fn tool_catalog_has_expected_tools() {
        let catalog = RuntimeToolCatalog;
        let descriptors = catalog.descriptors();
        assert_eq!(descriptors.len(), 67, "expected 67 tool descriptors, got {}", descriptors.len());
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

    // ── P8-D: text-level tool-call scanner ─────────────────────────────────

    #[test]
    fn scan_text_tool_call_detects_qwen_marker() {
        let input = r#"sure, let me look that up <|tool_call|>tool-web-search(query="济南未来三天天气预报")<tool_call|>"#;
        let (name, args) = scan_text_tool_call(input).expect("qwen marker should be detected");
        assert_eq!(name, "tool-web-search");
        assert!(args.contains("济南未来三天天气预报"));
    }

    #[test]
    fn scan_text_tool_call_detects_deepseek_marker() {
        let input = "<|tool_calls_begin|>browse(url=\"https://example.com\")";
        let (name, args) = scan_text_tool_call(input).expect("deepseek marker should be detected");
        assert_eq!(name, "browse");
        assert_eq!(args, "url=\"https://example.com\"");
    }

    #[test]
    fn scan_text_tool_call_detects_llama_python_tag() {
        let input = "<|python_tag|>get_weather(city=\"Jinan\", days=3)";
        let (name, args) = scan_text_tool_call(input).expect("llama python_tag should be detected");
        assert_eq!(name, "get_weather");
        assert!(args.contains("Jinan"));
    }

    #[test]
    fn scan_text_tool_call_no_marker_returns_none() {
        assert!(scan_text_tool_call("plain assistant reply, no tool call here").is_none());
    }

    #[test]
    fn scan_text_tool_call_empty_after_marker_returns_none() {
        assert!(scan_text_tool_call("<|tool_call|>").is_none());
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

/// Hosts that are pre-approved for `http-get` without an approval round-trip.
/// Strictly public read-only APIs / reference sources that cannot be used to
/// exfiltrate workspace data. Kept conservative on purpose — expand only for
/// hosts that are (a) HTTPS, (b) serve static/public data, (c) have no
/// side-effecting GET endpoints.
const HTTP_GET_PREAPPROVED_HOSTS: &[&str] = &[
    // Weather
    "wttr.in",
    // Time
    "worldtimeapi.org",
    // Foreign-exchange
    "open.er-api.com",
    "api.exchangerate-api.com",
    // Financial (public quote endpoints)
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    // Reference / encyclopedia
    "en.wikipedia.org",
    "zh.wikipedia.org",
    "en.wiktionary.org",
    "zh.wiktionary.org",
    // Package registries (read-only metadata)
    "registry.npmjs.org",
    "crates.io",
    "index.crates.io",
    "pypi.org",
    // Misc public JSON
    "api.github.com",
    "raw.githubusercontent.com",
    "httpbin.org",
];

fn http_get_host_is_preapproved(raw_payload: &str) -> bool {
    let url = raw_payload.trim();
    // Scheme must be https (or http to wttr.in which only serves http to some
    // regions). Anything else — file://, ftp://, gopher:// — still routes
    // through the approval gate.
    let rest = match url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        Some(r) => r,
        None => return false,
    };
    let host_end = rest
        .find(['/', '?', '#', ':'])
        .unwrap_or(rest.len());
    let host = rest[..host_end].to_ascii_lowercase();
    HTTP_GET_PREAPPROVED_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
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