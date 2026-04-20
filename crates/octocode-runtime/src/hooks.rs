//! Hooks system — user-defined pre/post commands for tool execution.
//! Inspired by Claude Code v3 hooks: .claude/settings.json hooks configuration.
//!
//! Hooks can be defined per-tool or globally. They run shell commands before/after
//! tool execution and can gate or modify behavior.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use octocode_core::ShellKind;

/// A single hook definition.
#[derive(Debug, Clone)]
pub struct HookDef {
    /// Shell command to run.
    pub command: String,
    /// When to run: "before" or "after" the tool.
    pub timing: HookTiming,
    /// If true, a non-zero exit from a "before" hook will block tool execution.
    pub blocking: bool,
    /// Timeout for the hook command (milliseconds).
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookTiming {
    Before,
    After,
}

/// Result of running a hook.
#[derive(Debug, Clone)]
pub struct HookResult {
    pub hook_name: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub blocked: bool,
}

/// Hooks configuration loaded from workspace or user config.
#[derive(Debug, Clone, Default)]
pub struct HooksConfig {
    /// Global hooks that run for every tool.
    pub global: Vec<HookDef>,
    /// Per-tool hooks keyed by tool name.
    pub per_tool: HashMap<String, Vec<HookDef>>,
}

impl HooksConfig {
    /// Load hooks from a TOML-like simple format at `.octocode/hooks.toml`
    /// or from a JSON-based config at `.octocode/settings.json`.
    pub fn discover(workspace_root: &str, config_home: &Path) -> Self {
        let mut config = Self::default();

        // Try workspace-local hooks
        let workspace_hooks = PathBuf::from(workspace_root).join(".octocode").join("hooks.json");
        if let Ok(content) = fs::read_to_string(&workspace_hooks) {
            if let Some(parsed) = parse_hooks_json(&content) {
                config.merge(parsed);
            }
        }

        // Try user-level hooks
        let user_hooks = config_home.join("hooks.json");
        if let Ok(content) = fs::read_to_string(&user_hooks) {
            if let Some(parsed) = parse_hooks_json(&content) {
                config.merge(parsed);
            }
        }

        config
    }

    fn merge(&mut self, other: HooksConfig) {
        self.global.extend(other.global);
        for (tool, hooks) in other.per_tool {
            self.per_tool.entry(tool).or_default().extend(hooks);
        }
    }

    /// Get all "before" hooks for a given tool name.
    pub fn before_hooks(&self, tool_name: &str) -> Vec<&HookDef> {
        let mut hooks: Vec<&HookDef> = self
            .global
            .iter()
            .filter(|h| h.timing == HookTiming::Before)
            .collect();
        if let Some(tool_hooks) = self.per_tool.get(tool_name) {
            hooks.extend(tool_hooks.iter().filter(|h| h.timing == HookTiming::Before));
        }
        hooks
    }

    /// Get all "after" hooks for a given tool name.
    pub fn after_hooks(&self, tool_name: &str) -> Vec<&HookDef> {
        let mut hooks: Vec<&HookDef> = self
            .global
            .iter()
            .filter(|h| h.timing == HookTiming::After)
            .collect();
        if let Some(tool_hooks) = self.per_tool.get(tool_name) {
            hooks.extend(tool_hooks.iter().filter(|h| h.timing == HookTiming::After));
        }
        hooks
    }
}

/// Execute a hook command and return the result.
pub fn run_hook(
    hook: &HookDef,
    tool_name: &str,
    tool_input: &str,
    shell: ShellKind,
    workspace_root: &str,
) -> HookResult {
    let _timeout = Duration::from_millis(hook.timeout_ms.max(1000));

    let (program, args) = match shell {
        ShellKind::PowerShell => ("powershell", vec!["-NoProfile", "-Command", &hook.command]),
        ShellKind::Bash => ("bash", vec!["-c", &hook.command]),
        ShellKind::Zsh => ("zsh", vec!["-c", &hook.command]),
        ShellKind::Cmd => ("cmd", vec!["/C", &hook.command]),
        ShellKind::Sh => ("sh", vec!["-c", &hook.command]),
    };

    let result = Command::new(program)
        .args(&args)
        .current_dir(workspace_root)
        .env("OCTOCODE_TOOL_NAME", tool_name)
        .env("OCTOCODE_TOOL_INPUT", tool_input)
        .output();

    match result {
        Ok(output) => {
            let exit_code = output.status.code();
            let blocked = hook.blocking && hook.timing == HookTiming::Before && exit_code != Some(0);
            HookResult {
                hook_name: hook.command.clone(),
                exit_code,
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                blocked,
            }
        }
        Err(e) => HookResult {
            hook_name: hook.command.clone(),
            exit_code: None,
            stdout: String::new(),
            stderr: format!("hook execution failed: {e}"),
            blocked: hook.blocking && hook.timing == HookTiming::Before,
        },
    }
}

/// Parse hooks from a JSON configuration.
/// Expected format:
/// ```json
/// {
///   "hooks": {
///     "global": [{"command": "...", "timing": "before", "blocking": true, "timeout_ms": 5000}],
///     "shell-command": [{"command": "...", "timing": "after", "blocking": false, "timeout_ms": 3000}]
///   }
/// }
/// ```
fn parse_hooks_json(content: &str) -> Option<HooksConfig> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    let hooks_obj = value.get("hooks")?.as_object()?;

    let mut config = HooksConfig::default();

    for (key, defs) in hooks_obj {
        let defs_array = defs.as_array()?;
        let mut parsed_hooks = Vec::new();

        for def in defs_array {
            let command = def.get("command")?.as_str()?.to_string();
            let timing = match def.get("timing").and_then(|t| t.as_str()).unwrap_or("before") {
                "after" => HookTiming::After,
                _ => HookTiming::Before,
            };
            let blocking = def.get("blocking").and_then(|b| b.as_bool()).unwrap_or(false);
            let timeout_ms = def.get("timeout_ms").and_then(|t| t.as_u64()).unwrap_or(5000);

            parsed_hooks.push(HookDef {
                command,
                timing,
                blocking,
                timeout_ms,
            });
        }

        if key == "global" {
            config.global.extend(parsed_hooks);
        } else {
            config.per_tool.insert(key.clone(), parsed_hooks);
        }
    }

    Some(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hooks_json() {
        let json = r#"{
            "hooks": {
                "global": [
                    {"command": "echo before", "timing": "before", "blocking": true, "timeout_ms": 3000}
                ],
                "shell-command": [
                    {"command": "echo after-shell", "timing": "after", "blocking": false, "timeout_ms": 2000}
                ]
            }
        }"#;

        let config = parse_hooks_json(json).unwrap();
        assert_eq!(config.global.len(), 1);
        assert_eq!(config.global[0].command, "echo before");
        assert_eq!(config.global[0].timing, HookTiming::Before);
        assert!(config.global[0].blocking);

        let shell_hooks = config.per_tool.get("shell-command").unwrap();
        assert_eq!(shell_hooks.len(), 1);
        assert_eq!(shell_hooks[0].timing, HookTiming::After);
    }

    #[test]
    fn test_before_after_hooks() {
        let config = HooksConfig {
            global: vec![
                HookDef { command: "g1".into(), timing: HookTiming::Before, blocking: false, timeout_ms: 1000 },
                HookDef { command: "g2".into(), timing: HookTiming::After, blocking: false, timeout_ms: 1000 },
            ],
            per_tool: {
                let mut m = HashMap::new();
                m.insert("read-file".into(), vec![
                    HookDef { command: "rf1".into(), timing: HookTiming::Before, blocking: true, timeout_ms: 1000 },
                ]);
                m
            },
        };

        let before = config.before_hooks("read-file");
        assert_eq!(before.len(), 2); // g1 + rf1
        let after = config.after_hooks("read-file");
        assert_eq!(after.len(), 1); // g2
    }

    #[test]
    fn test_empty_hooks_config() {
        let config = HooksConfig::default();
        assert!(config.before_hooks("anything").is_empty());
        assert!(config.after_hooks("anything").is_empty());
    }
}
