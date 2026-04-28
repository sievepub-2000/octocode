use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use octocode_core::{PromptRequest, PromptResponse, ToolCall, ToolResult};

pub mod discovery;
pub mod marketplace;

pub use discovery::{PluginConfig, PluginDiscovery};
pub use marketplace::{PluginMarketplace, PluginVersion, RegistryEntry, MarketplaceListing, InstallStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginDescriptor {
    pub id: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginAuditEvent {
    pub at_ms: u128,
    pub plugin_id: String,
    pub hook: String,
    pub detail: String,
}

pub enum PluginHook<'a> {
    SessionStart { session_id: &'a str },
    SessionEnd { session_id: &'a str },
    BeforePrompt { session_id: &'a str, request: &'a PromptRequest },
    AfterPrompt {
        session_id: &'a str,
        response: Result<&'a PromptResponse, &'a str>,
    },
    BeforeTool { session_id: &'a str, call: &'a ToolCall },
    AfterTool {
        session_id: &'a str,
        call: &'a ToolCall,
        result: Result<&'a ToolResult, &'a str>,
    },
    BeforeCompaction { session_id: &'a str, message_count: usize },
    AfterCompaction { session_id: &'a str, removed_count: usize },
    ErrorRecovery { session_id: &'a str, error: &'a str, action: &'a str },
}

impl<'a> PluginHook<'a> {
    fn label(&self) -> &'static str {
        match self {
            Self::SessionStart { .. } => "session-start",
            Self::SessionEnd { .. } => "session-end",
            Self::BeforePrompt { .. } => "before-prompt",
            Self::AfterPrompt { .. } => "after-prompt",
            Self::BeforeTool { .. } => "before-tool",
            Self::AfterTool { .. } => "after-tool",
            Self::BeforeCompaction { .. } => "before-compaction",
            Self::AfterCompaction { .. } => "after-compaction",
            Self::ErrorRecovery { .. } => "error-recovery",
        }
    }
}

pub trait RuntimePlugin: Send + Sync {
    fn descriptor(&self) -> PluginDescriptor;
    fn on_hook(&self, hook: &PluginHook<'_>) -> Option<String>;
}

pub struct PluginHost {
    plugins: Vec<Box<dyn RuntimePlugin>>,
    audit_log: Mutex<Vec<PluginAuditEvent>>,
    enabled_plugins: Mutex<HashMap<String, bool>>,
    plugin_configs: Mutex<HashMap<String, PluginConfig>>,
}

impl Default for PluginHost {
    fn default() -> Self {
        Self {
            plugins: vec![Box::new(LifecycleAuditPlugin)],
            audit_log: Mutex::new(Vec::new()),
            enabled_plugins: Mutex::new(HashMap::new()),
            plugin_configs: Mutex::new(HashMap::new()),
        }
    }
}

impl PluginHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_plugin_config(&self, config: PluginConfig) {
        let mut configs = self.plugin_configs.lock().expect("plugin configs lock poisoned");
        let mut enabled = self.enabled_plugins.lock().expect("enabled plugins lock poisoned");
        
        enabled.insert(config.id.clone(), config.enabled);
        configs.insert(config.id.clone(), config);
    }

    pub fn enable_plugin(&self, id: &str) {
        let mut enabled = self.enabled_plugins.lock().expect("enabled plugins lock poisoned");
        enabled.insert(id.to_string(), true);
    }

    pub fn disable_plugin(&self, id: &str) {
        let mut enabled = self.enabled_plugins.lock().expect("enabled plugins lock poisoned");
        enabled.insert(id.to_string(), false);
    }

    pub fn is_plugin_enabled(&self, id: &str) -> bool {
        let enabled = self.enabled_plugins.lock().expect("enabled plugins lock poisoned");
        enabled.get(id).copied().unwrap_or(true)
    }

    pub fn list_plugins(&self) -> Vec<PluginConfig> {
        let configs = self.plugin_configs.lock().expect("plugin configs lock poisoned");
        configs.values().cloned().collect()
    }

    pub fn dispatch(&self, hook: PluginHook<'_>) {
        let mut new_events = Vec::new();
        for plugin in &self.plugins {
            let descriptor = plugin.descriptor();
            if !self.is_plugin_enabled(&descriptor.id) {
                continue;
            }
            // Catch panics so a misbehaving plugin doesn't crash the runtime.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                plugin.on_hook(&hook)
            }));
            match result {
                Ok(Some(detail)) => {
                    new_events.push(PluginAuditEvent {
                        at_ms: now_ms(),
                        plugin_id: descriptor.id.clone(),
                        hook: String::from(hook.label()),
                        detail,
                    });
                }
                Ok(None) => {}
                Err(_) => {
                    new_events.push(PluginAuditEvent {
                        at_ms: now_ms(),
                        plugin_id: descriptor.id.clone(),
                        hook: String::from(hook.label()),
                        detail: String::from("plugin panicked — hook skipped"),
                    });
                }
            }
        }

        if new_events.is_empty() {
            return;
        }

        let mut guard = self.audit_log.lock().expect("plugin audit log lock poisoned");
        guard.extend(new_events);
        if guard.len() > 48 {
            let drain = guard.len() - 48;
            guard.drain(0..drain);
        }
    }

    pub fn audit_events(&self) -> Vec<PluginAuditEvent> {
        self.audit_log
            .lock()
            .expect("plugin audit log lock poisoned")
            .clone()
    }
}

struct LifecycleAuditPlugin;

impl RuntimePlugin for LifecycleAuditPlugin {
    fn descriptor(&self) -> PluginDescriptor {
        PluginDescriptor {
            id: "lifecycle-audit".to_string(),
            summary: "Audit SessionStart/Prompt/Tool hooks for Iteration 2 bootstrap".to_string(),
        }
    }

    fn on_hook(&self, hook: &PluginHook<'_>) -> Option<String> {
        let detail = match hook {
            PluginHook::SessionStart { session_id } => format!("session={}", session_id),
            PluginHook::SessionEnd { session_id } => format!("session={} ended", session_id),
            PluginHook::BeforePrompt { session_id, request } => format!(
                "session={} chars={} model={}",
                session_id,
                request.text.chars().count(),
                request.model.as_deref().unwrap_or("auto")
            ),
            PluginHook::AfterPrompt { session_id, response } => match response {
                Ok(response) => format!(
                    "session={} outputChars={}",
                    session_id,
                    response.output.chars().count()
                ),
                Err(error) => format!("session={} error={}", session_id, error),
            },
            PluginHook::BeforeTool { session_id, call } => format!(
                "session={} tool={} inputChars={}",
                session_id,
                call.name,
                call.input.chars().count()
            ),
            PluginHook::AfterTool {
                session_id,
                call,
                result,
            } => match result {
                Ok(result) => format!(
                    "session={} tool={} outputChars={}",
                    session_id,
                    call.name,
                    result.output.chars().count()
                ),
                Err(error) => format!("session={} tool={} error={}", session_id, call.name, error),
            },
            PluginHook::BeforeCompaction { session_id, message_count } => {
                format!("session={} messages={}", session_id, message_count)
            }
            PluginHook::AfterCompaction { session_id, removed_count } => {
                format!("session={} removed={}", session_id, removed_count)
            }
            PluginHook::ErrorRecovery { session_id, error, action } => {
                format!("session={} error={} action={}", session_id, error, action)
            }
        };
        Some(detail)
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::{PluginHook, PluginHost};
    use octocode_core::{PromptRequest, ToolCall, PermissionMode};

    #[test]
    fn plugin_host_records_lifecycle_audit_events() {
        let host = PluginHost::default();
        host.dispatch(PluginHook::SessionStart { session_id: "demo" });
        host.dispatch(PluginHook::BeforePrompt {
            session_id: "demo",
            request: &PromptRequest {
                text: String::from("hello"),
                model: None,
                system_prompt: None,
                history: vec![],
            },
        });
        host.dispatch(PluginHook::BeforeTool {
            session_id: "demo",
            call: &ToolCall {
                name: String::from("echo"),
                input: String::from("hi"),
                permission: PermissionMode::ReadOnly,
            },
        });

        let events = host.audit_events();
        assert_eq!(events.len(), 3);
        assert!(events.iter().any(|event| event.hook == "session-start"));
        assert!(events.iter().any(|event| event.hook == "before-prompt"));
        assert!(events.iter().any(|event| event.hook == "before-tool"));
    }

    #[test]
    fn plugin_host_dispatch_skips_disabled_plugins() {
        let host = PluginHost::default();
        // Disable the built-in lifecycle-audit plugin by id
        host.disable_plugin("lifecycle-audit");
        host.dispatch(PluginHook::SessionStart { session_id: "skip" });
        let events = host.audit_events();
        assert!(events.is_empty(), "disabled plugin should not produce events");
    }
}