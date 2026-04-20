//! Per-tool permission rules system.
//! Extends the basic PermissionMode with granular path-based and pattern-based rules.
//! Similar to Claude Code v3's allowedTools and permissions configuration.

use std::fs;
use std::path::{Path, PathBuf};

use octocode_core::{OctoError, PermissionMode};

/// A permission rule for a specific tool.
#[derive(Debug, Clone)]
pub struct ToolPermissionRule {
    /// Tool name this rule applies to.
    pub tool_name: String,
    /// Whether the tool is allowed or denied.
    pub allowed: bool,
    /// Optional path patterns that restrict where the tool can operate.
    /// If empty, the rule applies globally.
    pub path_patterns: Vec<String>,
    /// Optional condition: "always", "ask", "deny".
    pub mode: ToolPermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPermissionMode {
    /// Always allow without asking.
    Always,
    /// Ask for confirmation each time.
    Ask,
    /// Always deny.
    Deny,
}

/// Granular permission rules configuration.
#[derive(Debug, Clone, Default)]
pub struct PermissionRules {
    /// Default permission mode when no specific rule matches.
    pub default_mode: Option<PermissionMode>,
    /// Per-tool rules.
    pub rules: Vec<ToolPermissionRule>,
    /// Denied paths (glob patterns) — no tool can operate on these.
    pub denied_paths: Vec<String>,
}

impl PermissionRules {
    /// Load from workspace config `.octocode/permissions.json`.
    pub fn discover(workspace_root: &str, config_home: &Path) -> Self {
        let mut rules = Self::default();

        // Workspace-level permissions
        let ws_perms = PathBuf::from(workspace_root).join(".octocode").join("permissions.json");
        if let Ok(content) = fs::read_to_string(&ws_perms) {
            if let Some(parsed) = parse_permissions_json(&content) {
                rules.merge(parsed);
            }
        }

        // User-level permissions
        let user_perms = config_home.join("permissions.json");
        if let Ok(content) = fs::read_to_string(&user_perms) {
            if let Some(parsed) = parse_permissions_json(&content) {
                rules.merge(parsed);
            }
        }

        rules
    }

    fn merge(&mut self, other: PermissionRules) {
        if self.default_mode.is_none() {
            self.default_mode = other.default_mode;
        }
        self.rules.extend(other.rules);
        self.denied_paths.extend(other.denied_paths);
    }

    /// Check if a tool operation is allowed.
    /// Returns `Ok(())` if allowed, `Err` with explanation if denied.
    pub fn check_tool_access(
        &self,
        tool_name: &str,
        path: Option<&str>,
    ) -> Result<ToolPermissionMode, OctoError> {
        // Check denied paths first
        if let Some(target_path) = path {
            for denied in &self.denied_paths {
                if path_matches_pattern(target_path, denied) {
                    return Err(OctoError::Permission(format!(
                        "path '{}' is denied by permission rule '{}'",
                        target_path, denied
                    )));
                }
            }
        }

        // Check tool-specific rules
        for rule in &self.rules {
            if rule.tool_name == tool_name || rule.tool_name == "*" {
                // Check path patterns if any
                if !rule.path_patterns.is_empty() {
                    if let Some(target_path) = path {
                        let matches = rule.path_patterns.iter().any(|p| path_matches_pattern(target_path, p));
                        if !matches {
                            continue; // Rule doesn't apply to this path
                        }
                    }
                }

                if !rule.allowed {
                    return Err(OctoError::Permission(format!(
                        "tool '{}' is denied by permission rule",
                        tool_name
                    )));
                }

                return Ok(rule.mode.clone());
            }
        }

        // Default: allow with ask
        Ok(ToolPermissionMode::Ask)
    }
}

/// Simple glob-like path matching (supports * and **).
fn path_matches_pattern(path: &str, pattern: &str) -> bool {
    let normalized_path = path.replace('\\', "/");
    let normalized_pattern = pattern.replace('\\', "/");

    if normalized_pattern == "*" || normalized_pattern == "**" {
        return true;
    }

    if normalized_pattern.contains("**") {
        // Double-star: match any number of path segments
        let parts: Vec<&str> = normalized_pattern.split("**").collect();
        if parts.len() == 2 {
            let prefix = parts[0].trim_end_matches('/');
            let suffix = parts[1].trim_start_matches('/');
            let starts = prefix.is_empty() || normalized_path.starts_with(prefix);
            let ends = suffix.is_empty() || normalized_path.ends_with(suffix);
            return starts && ends;
        }
    }

    if normalized_pattern.contains('*') {
        // Single star: match within one path segment
        let parts: Vec<&str> = normalized_pattern.split('*').collect();
        if parts.len() == 2 {
            return normalized_path.starts_with(parts[0]) && normalized_path.ends_with(parts[1]);
        }
    }

    normalized_path == normalized_pattern || normalized_path.starts_with(&format!("{}/", normalized_pattern))
}

/// Parse permissions from JSON configuration.
fn parse_permissions_json(content: &str) -> Option<PermissionRules> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;

    let mut rules = PermissionRules::default();

    // Parse default mode
    if let Some(mode_str) = value.get("default_mode").and_then(|m| m.as_str()) {
        rules.default_mode = Some(match mode_str {
            "danger-full-access" => PermissionMode::DangerFullAccess,
            "workspace-write" => PermissionMode::WorkspaceWrite,
            _ => PermissionMode::ReadOnly,
        });
    }

    // Parse denied paths
    if let Some(denied) = value.get("denied_paths").and_then(|d| d.as_array()) {
        for p in denied {
            if let Some(s) = p.as_str() {
                rules.denied_paths.push(s.to_string());
            }
        }
    }

    // Parse tool rules
    if let Some(tool_rules) = value.get("tools").and_then(|t| t.as_object()) {
        for (tool_name, rule_val) in tool_rules {
            let allowed = rule_val.get("allowed").and_then(|a| a.as_bool()).unwrap_or(true);
            let mode = match rule_val.get("mode").and_then(|m| m.as_str()).unwrap_or("ask") {
                "always" => ToolPermissionMode::Always,
                "deny" => ToolPermissionMode::Deny,
                _ => ToolPermissionMode::Ask,
            };
            let path_patterns = rule_val
                .get("paths")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            rules.rules.push(ToolPermissionRule {
                tool_name: tool_name.clone(),
                allowed,
                path_patterns,
                mode,
            });
        }
    }

    Some(rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_matches_pattern() {
        assert!(path_matches_pattern("src/main.rs", "src/**"));
        assert!(path_matches_pattern("src/foo/bar.rs", "src/**"));
        assert!(!path_matches_pattern("tests/main.rs", "src/**"));
        assert!(path_matches_pattern("src/main.rs", "*.rs"));
        assert!(path_matches_pattern("anything", "*"));
        assert!(path_matches_pattern("node_modules/foo", "node_modules"));
    }

    #[test]
    fn test_permission_rules_basic() {
        let rules = PermissionRules {
            default_mode: None,
            rules: vec![
                ToolPermissionRule {
                    tool_name: "shell-command".into(),
                    allowed: true,
                    path_patterns: vec![],
                    mode: ToolPermissionMode::Ask,
                },
                ToolPermissionRule {
                    tool_name: "delete-file".into(),
                    allowed: false,
                    path_patterns: vec![],
                    mode: ToolPermissionMode::Deny,
                },
            ],
            denied_paths: vec!["node_modules/**".into()],
        };

        assert!(rules.check_tool_access("shell-command", None).is_ok());
        assert!(rules.check_tool_access("delete-file", None).is_err());
        assert!(rules.check_tool_access("read-file", Some("node_modules/foo.js")).is_err());
        assert!(rules.check_tool_access("read-file", Some("src/main.rs")).is_ok());
    }

    #[test]
    fn test_parse_permissions_json() {
        let json = r#"{
            "default_mode": "read-only",
            "denied_paths": ["node_modules/**", ".git/**"],
            "tools": {
                "shell-command": {"allowed": true, "mode": "ask"},
                "write-file": {"allowed": true, "mode": "always", "paths": ["src/**"]}
            }
        }"#;

        let rules = parse_permissions_json(json).unwrap();
        assert_eq!(rules.denied_paths.len(), 2);
        assert_eq!(rules.rules.len(), 2);
        assert_eq!(rules.rules[1].mode, ToolPermissionMode::Always);
        assert_eq!(rules.rules[1].path_patterns, vec!["src/**"]);
    }
}
