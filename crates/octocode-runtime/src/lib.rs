use std::fs;
use std::path::PathBuf;

use octocode_core::{
    CommandDescriptor, ConfigPaths, ConversationMessage, ConversationRole, ConversationSession,
    ConversationStore, DoctorReport, ModelProvider, OctoError, PermissionMode, PermissionPolicy,
    PlatformKind, PlatformSupport, PromptRequest, PromptResponse, ProviderCircuitEvent,
    ProviderCircuitStatus, ProviderDescriptor, ProviderHealth, ProviderRouteStatus, RuntimeConfig,
    RuntimeStatus,
    SessionSummary, ShellKind, ToolCall, ToolCatalog, ToolDescriptor,
    ToolExecutor, ToolResult, UiSnapshot, WorkspaceContext,
};

mod permission;
mod router;
mod session;
mod tools;

pub use permission::RuntimePermissionPolicy;
pub use router::RuntimeProviderRouter;
pub use session::{FileSessionStore, MemorySessionStore};
pub use tools::{RuntimeToolCatalog, WorkspaceToolExecutor};

const DEFAULT_PROVIDER_ID: &str = "local-openai";
const DEFAULT_PROVIDER_BASE_URL: &str = "http://192.168.110.2:8000/v1";
const DEFAULT_MODEL: &str = "gemma-4-31b-it-q8-prod";
const DEFAULT_HISTORY_LIMIT: usize = 24;

pub struct NativePlatform {
    context: WorkspaceContext,
}

#[derive(Debug, Clone)]
pub struct ConfigLoader {
    paths: ConfigPaths,
}

impl ConfigLoader {
    pub fn new(paths: ConfigPaths) -> Self {
        Self { paths }
    }

    pub fn load(&self) -> Result<RuntimeConfig, OctoError> {
        let path = self.config_file_path();
        if !path.is_file() {
            return Ok(Self::default_config());
        }

        let raw = fs::read_to_string(&path).map_err(|error| {
            OctoError::Runtime(format!("failed to read config {}: {error}", path.display()))
        })?;

        let mut config = Self::default_config();

        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((key, value)) = trimmed.split_once('=') else {
                continue;
            };
            match key.trim() {
                "provider_id" => {
                    let value = value.trim();
                    if !value.is_empty() {
                        config.provider_id = Some(String::from(value));
                    }
                }
                "provider_base_url" => {
                    let value = value.trim();
                    if !value.is_empty() {
                        config.provider_base_url = Some(String::from(value));
                    }
                }
                "default_model" => {
                    let value = value.trim();
                    if !value.is_empty() {
                        config.default_model = Some(String::from(value));
                    }
                }
                "permission_mode" => {
                    config.permission_mode = parse_permission_mode(value.trim());
                }
                "history_limit" => {
                    config.history_limit = value.trim().parse::<usize>().unwrap_or(DEFAULT_HISTORY_LIMIT);
                }
                _ => {}
            }
        }

        Ok(config)
    }

    pub fn save(&self, config: &RuntimeConfig) -> Result<PathBuf, OctoError> {
        let path = self.config_file_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Runtime(format!("failed to create config dir {}: {error}", parent.display()))
            })?;
        }

        let body = format!(
            concat!(
                "# Octocode config\n",
                "provider_id={}\n",
                "provider_base_url={}\n",
                "default_model={}\n",
                "permission_mode={}\n",
                "history_limit={}\n"
            ),
            config.provider_id.as_deref().unwrap_or(DEFAULT_PROVIDER_ID),
            config
                .provider_base_url
                .as_deref()
                .unwrap_or(DEFAULT_PROVIDER_BASE_URL),
            config.default_model.as_deref().unwrap_or(DEFAULT_MODEL),
            permission_mode_label(&config.permission_mode),
            config.history_limit.max(1)
        );

        fs::write(&path, body).map_err(|error| {
            OctoError::Runtime(format!("failed to write config {}: {error}", path.display()))
        })?;
        Ok(path)
    }

    pub fn ensure_default_file(&self) -> Result<PathBuf, OctoError> {
        let path = self.config_file_path();
        if !path.is_file() {
            self.save(&Self::default_config())?;
        }
        Ok(path)
    }

    pub fn config_file_path(&self) -> PathBuf {
        PathBuf::from(&self.paths.config_home).join("octocode.conf")
    }

    pub fn default_config() -> RuntimeConfig {
        RuntimeConfig {
            provider_id: Some(String::from(DEFAULT_PROVIDER_ID)),
            provider_base_url: Some(String::from(DEFAULT_PROVIDER_BASE_URL)),
            default_model: Some(String::from(DEFAULT_MODEL)),
            permission_mode: PermissionMode::WorkspaceWrite,
            history_limit: DEFAULT_HISTORY_LIMIT,
        }
    }
}

const COMMANDS: &[CommandDescriptor] = &[
    CommandDescriptor {
        name: "prompt",
        summary: "Run a one-shot prompt",
    },
    CommandDescriptor {
        name: "chat",
        summary: "Append a user turn into a session",
    },
    CommandDescriptor {
        name: "resume",
        summary: "Resume the latest or named session",
    },
    CommandDescriptor {
        name: "sessions",
        summary: "List local sessions",
    },
    CommandDescriptor {
        name: "session-show",
        summary: "Show one session transcript",
    },
    CommandDescriptor {
        name: "session-add",
        summary: "Persist a local session",
    },
    CommandDescriptor {
        name: "session-export",
        summary: "Export local sessions to a file",
    },
    CommandDescriptor {
        name: "tool",
        summary: "Run a built-in tool",
    },
    CommandDescriptor {
        name: "plan",
        summary: "Draft a workflow plan into the current session",
    },
    CommandDescriptor {
        name: "workflow",
        summary: "Append a workflow step into the current session",
    },
    CommandDescriptor {
        name: "agent",
        summary: "Run a session-scoped agent action with provider and local orchestration",
    },
    CommandDescriptor {
        name: "repl",
        summary: "Evaluate a nested runtime command inside the current session",
    },
    CommandDescriptor {
        name: "circuit-log",
        summary: "Show circuit event log and recovery timeline",
    },
    CommandDescriptor {
        name: "health",
        summary: "Inspect provider health and fallback readiness",
    },
    CommandDescriptor {
        name: "desktop",
        summary: "Launch the embedded desktop shell for the WebUI",
    },
    CommandDescriptor {
        name: "tools",
        summary: "List built-in tool descriptors",
    },
    CommandDescriptor {
        name: "workspace",
        summary: "Show workspace platform context",
    },
    CommandDescriptor {
        name: "providers",
        summary: "List configured provider surfaces",
    },
    CommandDescriptor {
        name: "routes",
        summary: "Show the explicit provider routing chain and active route",
    },
    CommandDescriptor {
        name: "doctor",
        summary: "Show platform and config diagnostics",
    },
    CommandDescriptor {
        name: "status",
        summary: "Show effective runtime status",
    },
    CommandDescriptor {
        name: "snapshot",
        summary: "Show the unified runtime snapshot for CLI and UI consumers",
    },
    CommandDescriptor {
        name: "permissions",
        summary: "Show or set effective permission mode",
    },
    CommandDescriptor {
        name: "config-init",
        summary: "Create the default config file",
    },
    CommandDescriptor {
        name: "config-show",
        summary: "Inspect the current config file",
    },
    CommandDescriptor {
        name: "ui-export",
        summary: "Export UI state snapshot into a JSON file",
    },
    CommandDescriptor {
        name: "serve",
        summary: "Start the local interactive WebUI server",
    },
    CommandDescriptor {
        name: "commands",
        summary: "List the current CLI command surface",
    },
];

impl NativePlatform {
    pub fn detect(workspace_root: String) -> Self {
        let platform = if cfg!(target_os = "windows") {
            PlatformKind::Windows
        } else if cfg!(target_os = "macos") {
            PlatformKind::MacOs
        } else {
            PlatformKind::Linux
        };

        let preferred_shell = match platform {
            PlatformKind::Windows => ShellKind::PowerShell,
            PlatformKind::MacOs => ShellKind::Zsh,
            PlatformKind::Linux => ShellKind::Bash,
        };

        Self {
            context: WorkspaceContext {
                root: workspace_root,
                platform,
                preferred_shell,
            },
        }
    }
}

impl PlatformSupport for NativePlatform {
    fn context(&self) -> &WorkspaceContext {
        &self.context
    }

    fn config_paths(&self) -> ConfigPaths {
        match self.context.platform {
            PlatformKind::Windows => {
                let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| String::from("."));
                let app_data = std::env::var("APPDATA")
                    .unwrap_or_else(|_| format!("{user_profile}\\AppData\\Roaming"));
                let local_app_data = std::env::var("LOCALAPPDATA")
                    .unwrap_or_else(|_| format!("{user_profile}\\AppData\\Local"));
                ConfigPaths {
                    config_home: format!("{app_data}\\Octocode"),
                    cache_home: format!("{local_app_data}\\Octocode\\Cache"),
                    data_home: format!("{local_app_data}\\Octocode\\Data"),
                }
            }
            PlatformKind::MacOs => {
                let home = std::env::var("HOME").unwrap_or_else(|_| String::from("."));
                ConfigPaths {
                    config_home: format!("{home}/Library/Application Support/Octocode"),
                    cache_home: format!("{home}/Library/Caches/Octocode"),
                    data_home: format!("{home}/Library/Application Support/Octocode/Data"),
                }
            }
            PlatformKind::Linux => {
                let home = std::env::var("HOME").unwrap_or_else(|_| String::from("."));
                ConfigPaths {
                    config_home: std::env::var("XDG_CONFIG_HOME")
                        .unwrap_or_else(|_| format!("{home}/.config/octocode")),
                    cache_home: std::env::var("XDG_CACHE_HOME")
                        .unwrap_or_else(|_| format!("{home}/.cache/octocode")),
                    data_home: std::env::var("XDG_DATA_HOME")
                        .unwrap_or_else(|_| format!("{home}/.local/share/octocode")),
                }
            }
        }
    }
}

pub struct OctocodeRuntime<P, S, T> {
    provider: P,
    sessions: S,
    tools: T,
    platform: NativePlatform,
    config: RuntimeConfig,
    available_providers: Vec<ProviderDescriptor>,
    permission_policy: RuntimePermissionPolicy,
    tool_catalog: RuntimeToolCatalog,
}

impl<P, S, T> OctocodeRuntime<P, S, T>
where
    P: ModelProvider,
    S: ConversationStore,
    T: ToolExecutor,
{
    pub fn new(
        provider: P,
        sessions: S,
        tools: T,
        workspace: WorkspaceContext,
        available_providers: Vec<ProviderDescriptor>,
    ) -> Self {
        let platform = NativePlatform { context: workspace };
        let config = ConfigLoader::new(platform.config_paths())
            .load()
            .unwrap_or_else(|_| ConfigLoader::default_config());
        Self {
            provider,
            sessions,
            tools,
            platform,
            config,
            available_providers,
            permission_policy: RuntimePermissionPolicy,
            tool_catalog: RuntimeToolCatalog,
        }
    }

    pub fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        self.provider.prompt(request)
    }

    pub fn prompt_in_session(&self, session_id: &str, text: &str) -> Result<PromptResponse, OctoError> {
        self.ensure_session_exists(session_id)?;
        self.append_session_message(session_id, ConversationRole::User, String::from(text))?;

        let response = self.provider.prompt(PromptRequest {
            text: String::from(text),
            model: self.config.default_model.clone(),
        });

        match response {
            Ok(response) => {
                self.append_session_message(
                    session_id,
                    ConversationRole::Assistant,
                    response.output.clone(),
                )?;
                self.apply_history_limit(session_id)?;
                Ok(response)
            }
            Err(error) => {
                self.append_session_message(
                    session_id,
                    ConversationRole::System,
                    format!("provider-error: {error}"),
                )?;
                self.apply_history_limit(session_id)?;
                Err(error)
            }
        }
    }

    pub fn agent_action_in_session(
        &self,
        session_id: &str,
        instruction: &str,
    ) -> Result<PromptResponse, OctoError> {
        self.ensure_session_exists(session_id)?;

        let normalized_text = instruction.replace("\\n", "\n");
        let normalized = normalized_text.trim();
        let goal = if normalized.is_empty() {
            "continue the current task"
        } else {
            normalized.lines().next().unwrap_or(normalized).trim()
        };

        self.append_session_message(
            session_id,
            ConversationRole::System,
            format!("agent-action requested: {goal}"),
        )?;

        let workspace_plan = self.build_session_workspace_plan(session_id, goal)?;
        self.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!("session-plan => {workspace_plan}"),
        )?;

        let workflow = self.run_tool(ToolCall {
            name: String::from("workflow-plan"),
            input: String::from(goal),
            permission: PermissionMode::ReadOnly,
        })?;
        self.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!("workflow-plan => {}", workflow.output),
        )?;

        let observations = self.collect_agent_observations(session_id, normalized)?;
        for (label, output) in &observations {
            self.append_session_message(
                session_id,
                ConversationRole::Tool,
                format!("{label} => {output}"),
            )?;
        }

        let (provider_strategy, use_local_fallback) = self.build_agent_provider_strategy()?;
        self.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!("provider-strategy => {provider_strategy}"),
        )?;

        let session = self.session(session_id)?;
        let context_tail = session
            .messages
            .iter()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|message| format!("{}: {}", message.role.as_str(), message.content))
            .collect::<Vec<_>>()
            .join("\n");
        let provider = self.provider.health();
        let observation_block = if observations.is_empty() {
            String::from("(no additional local observations)")
        } else {
            observations
                .iter()
                .map(|(label, output)| format!("[{label}]\n{output}"))
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        let prompt = format!(
            concat!(
                "You are the Octocode runtime agent.\n",
                "Goal: {}\n",
                "Active provider: {} ({:?})\n",
                "Permission mode: {:?}\n\n",
                "Session-aware workspace plan:\n{}\n\n",
                "Workflow scaffold:\n{}\n\n",
                "Provider strategy:\n{}\n\n",
                "Recent session context:\n{}\n\n",
                "Local observations:\n{}\n\n",
                "Return the next concrete implementation actions, expected validation, and any immediate risks."
            ),
            goal,
            provider.provider_id,
            provider.circuit_state,
            self.config.permission_mode,
            workspace_plan,
            workflow.output,
            provider_strategy,
            if context_tail.is_empty() {
                String::from("(empty)")
            } else {
                context_tail
            },
            observation_block,
        );

        if use_local_fallback {
            let fallback = PromptResponse {
                output: self.build_agent_fallback(
                    goal,
                    &workspace_plan,
                    &workflow.output,
                    &provider_strategy,
                    &observations,
                    Some("all providers unavailable or circuit-open; skipped provider dispatch"),
                ),
            };
            self.append_session_message(
                session_id,
                ConversationRole::Assistant,
                fallback.output.clone(),
            )?;
            self.apply_history_limit(session_id)?;
            return Ok(fallback);
        }

        match self.provider.prompt(PromptRequest {
            text: prompt,
            model: self.config.default_model.clone(),
        }) {
            Ok(response) => {
                self.append_session_message(
                    session_id,
                    ConversationRole::Assistant,
                    response.output.clone(),
                )?;
                self.apply_history_limit(session_id)?;
                Ok(response)
            }
            Err(error) => {
                self.append_session_message(
                    session_id,
                    ConversationRole::System,
                    format!("agent provider-error: {error}"),
                )?;
                let fallback = PromptResponse {
                    output: self.build_agent_fallback(
                        goal,
                        &workspace_plan,
                        &workflow.output,
                        &provider_strategy,
                        &observations,
                        Some(&format!("provider dispatch failed: {error}")),
                    ),
                };
                self.append_session_message(
                    session_id,
                    ConversationRole::Assistant,
                    fallback.output.clone(),
                )?;
                self.apply_history_limit(session_id)?;
                Ok(fallback)
            }
        }
    }

    pub fn run_tool_in_session(
        &self,
        session_id: &str,
        mut call: ToolCall,
    ) -> Result<ToolResult, OctoError> {
        self.ensure_session_exists(session_id)?;
        if call.name == "agent-action" {
            let response = self.agent_action_in_session(session_id, &call.input)?;
            return Ok(ToolResult {
                output: response.output,
            });
        }
        let descriptor = self
            .tool_descriptor(&call.name)
            .ok_or_else(|| OctoError::Runtime(format!("unknown tool: {}", call.name)))?;
        call.permission = descriptor.minimum_permission.clone();
        self.ensure_permission(&call.permission, descriptor.name)?;
        let result = self.tools.execute(call.clone())?;
        self.append_session_message(
            session_id,
            ConversationRole::Tool,
            format!("{} => {}", call.name, result.output),
        )?;
        self.apply_history_limit(session_id)?;
        Ok(result)
    }

    pub fn append_session_message(
        &self,
        session_id: &str,
        role: ConversationRole,
        content: String,
    ) -> Result<(), OctoError> {
        self.ensure_session_exists(session_id)?;
        self.sessions
            .append_message(session_id, ConversationMessage { role, content })
    }

    pub fn provider_descriptor(&self) -> ProviderDescriptor {
        self.provider.descriptor()
    }

    pub fn providers(&self) -> &[ProviderDescriptor] {
        &self.available_providers
    }

    pub fn sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        self.sessions.list_sessions()
    }

    pub fn session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        self.sessions.load_session(id)
    }

    pub fn resume_session(&self, id: Option<&str>) -> Result<ConversationSession, OctoError> {
        let resolved_id = match id {
            Some(id) if !id.trim().is_empty() => String::from(id),
            _ => self
                .sessions
                .latest_session_id()?
                .ok_or_else(|| OctoError::Session(String::from("no sessions available to resume")))?,
        };
        self.session(&resolved_id)
    }

    pub fn save_session(&self, session: SessionSummary) -> Result<(), OctoError> {
        self.sessions.save_session(session)
    }

    pub fn run_tool(&self, mut call: ToolCall) -> Result<ToolResult, OctoError> {
        let descriptor = self
            .tool_descriptor(&call.name)
            .ok_or_else(|| OctoError::Runtime(format!("unknown tool: {}", call.name)))?;
        call.permission = descriptor.minimum_permission.clone();
        self.ensure_permission(&call.permission, descriptor.name)?;
        self.tools.execute(call)
    }

    pub fn tools(&self) -> &[ToolDescriptor] {
        self.tool_catalog.descriptors()
    }

    pub fn workspace(&self) -> &WorkspaceContext {
        self.platform.context()
    }

    pub fn config_paths(&self) -> ConfigPaths {
        self.platform.config_paths()
    }

    pub fn config(&self) -> &RuntimeConfig {
        &self.config
    }

    pub fn doctor(&self) -> DoctorReport {
        DoctorReport {
            workspace: self.workspace().clone(),
            paths: self.config_paths(),
            config: self.config.clone(),
            provider_healths: self.provider.health_catalog(),
            provider_circuits: self.provider.circuit_catalog(),
            provider_routes: self.provider.route_statuses(),
        }
    }

    pub fn provider_healths(&self) -> Vec<ProviderHealth> {
        self.provider.health_catalog()
    }

    pub fn provider_circuits(&self) -> Vec<ProviderCircuitStatus> {
        self.provider.circuit_catalog()
    }

    pub fn provider_routes(&self) -> Vec<ProviderRouteStatus> {
        self.provider.route_statuses()
    }

    pub fn commands(&self) -> &'static [CommandDescriptor] {
        COMMANDS
    }

    pub fn init_config(&self) -> Result<PathBuf, OctoError> {
        ConfigLoader::new(self.platform.config_paths()).ensure_default_file()
    }

    pub fn config_file_path(&self) -> PathBuf {
        ConfigLoader::new(self.platform.config_paths()).config_file_path()
    }

    pub fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.config.permission_mode = mode;
    }

    pub fn set_provider_id(&mut self, provider_id: String) {
        self.config.provider_id = Some(provider_id);
    }

    pub fn set_provider_base_url(&mut self, provider_base_url: String) {
        self.config.provider_base_url = Some(provider_base_url);
    }

    pub fn set_default_model(&mut self, default_model: String) {
        self.config.default_model = Some(default_model);
    }

    pub fn set_history_limit(&mut self, history_limit: usize) {
        self.config.history_limit = history_limit.max(1);
    }

    pub fn save_config(&self) -> Result<PathBuf, OctoError> {
        ConfigLoader::new(self.platform.config_paths()).save(&self.config)
    }

    pub fn status(&self) -> Result<RuntimeStatus, OctoError> {
        let provider = self.provider.descriptor();
        let provider_health = self.provider.health();
        let provider_circuit = self.provider.circuit_status();
        Ok(RuntimeStatus {
            provider_id: provider.id,
            active_provider_id: self.provider.active_provider_id(),
            provider_kind: provider.kind,
            platform: self.platform.context().platform.clone(),
            permission_mode: self.config.permission_mode.clone(),
            session_count: self.sessions.list_sessions()?.len(),
            provider_health,
            provider_circuit,
            provider_routes: self.provider_routes(),
        })
    }

    pub fn export_sessions(&self, path: impl Into<PathBuf>) -> Result<PathBuf, OctoError> {
        let path = path.into();
        let sessions = self.sessions()?;
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|error| {
                    OctoError::Session(format!(
                        "failed to create export dir {}: {error}",
                        parent.display()
                    ))
                })?;
            }
        }

        let body = sessions
            .iter()
            .map(|session| {
                format!(
                    "id={} title={} model={}",
                    session.id,
                    session.title,
                    session.model.as_deref().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        fs::write(&path, if body.is_empty() { String::new() } else { format!("{body}\n") })
            .map_err(|error| {
                OctoError::Session(format!(
                    "failed to write export file {}: {error}",
                    path.display()
                ))
            })?;
        Ok(path)
    }

    pub fn snapshot(&self, active_session_id: Option<&str>) -> Result<UiSnapshot, OctoError> {
        let resolved_session = match active_session_id {
            Some(id) if !id.trim().is_empty() => Some(self.session(id)?),
            _ => self.resume_session(None).ok(),
        };
        Ok(UiSnapshot {
            status: self.status()?,
            workspace: self.workspace().clone(),
            config: self.config.clone(),
            providers: self.providers().to_vec(),
            provider_healths: self.provider_healths(),
            provider_circuits: self.provider_circuits(),
            provider_routes: self.provider_routes(),
            commands: self.commands().to_vec(),
            tools: self.tools().to_vec(),
            sessions: self.sessions()?,
            active_session: resolved_session,
        })
    }

    pub fn snapshot_json(&self, active_session_id: Option<&str>) -> Result<String, OctoError> {
        Ok(snapshot_to_json(&self.snapshot(active_session_id)?))
    }

    pub fn export_ui_state(
        &self,
        path: impl Into<PathBuf>,
        active_session_id: Option<&str>,
    ) -> Result<PathBuf, OctoError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|error| {
                    OctoError::Runtime(format!(
                        "failed to create UI export dir {}: {error}",
                        parent.display()
                    ))
                })?;
            }
        }
        let snapshot = self.snapshot(active_session_id)?;
        fs::write(&path, snapshot_to_json(&snapshot)).map_err(|error| {
            OctoError::Runtime(format!("failed to write UI state {}: {error}", path.display()))
        })?;
        Ok(path)
    }

    fn ensure_session_exists(&self, session_id: &str) -> Result<(), OctoError> {
        if self
            .sessions
            .list_sessions()?
            .iter()
            .any(|session| session.id == session_id)
        {
            return Ok(());
        }
        self.sessions.save_session(SessionSummary {
            id: String::from(session_id),
            title: format!("Session {session_id}"),
            model: self.config.default_model.clone(),
        })
    }

    fn apply_history_limit(&self, session_id: &str) -> Result<(), OctoError> {
        let limit = self.config.history_limit.max(1);
        let session = self.sessions.load_session(session_id)?;
        if session.messages.len() <= limit {
            return Ok(());
        }
        let retain_from = session.messages.len().saturating_sub(limit);
        let retained = session
            .messages
            .into_iter()
            .skip(retain_from)
            .collect::<Vec<_>>();
        self.sessions.replace_messages(session_id, retained)
    }

    fn tool_descriptor(&self, name: &str) -> Option<&ToolDescriptor> {
        self.tool_catalog.descriptor(name)
    }

    fn ensure_permission(&self, requested: &PermissionMode, tool_name: &str) -> Result<(), OctoError> {
        self.permission_policy.ensure_allowed(
            &self.config.permission_mode,
            requested,
            &format!("tool {tool_name}"),
        )
    }

    fn collect_agent_observations(
        &self,
        session_id: &str,
        instruction: &str,
    ) -> Result<Vec<(String, String)>, OctoError> {
        let mut observations = Vec::new();
        for directive in instruction.lines().skip(1).take(6) {
            let directive = directive.trim();
            if directive.is_empty() {
                continue;
            }

            let observation = if directive == "session-plan" {
                Some((
                    String::from("session-plan"),
                    self.build_session_workspace_plan(session_id, "current task")?,
                ))
            } else if let Some(spec) = directive.strip_prefix("chain ") {
                Some(self.execute_agent_chain(session_id, spec.trim())?)
            } else {
                self.execute_agent_directive(session_id, directive, None)?
            };

            if let Some(observation) = observation {
                observations.push(observation);
            }
        }
        Ok(observations)
    }

    fn execute_agent_chain(
        &self,
        session_id: &str,
        spec: &str,
    ) -> Result<(String, String), OctoError> {
        let steps = spec
            .split("=>")
            .map(str::trim)
            .filter(|step| !step.is_empty())
            .collect::<Vec<_>>();
        if steps.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "chain directive expects at least one step",
            )));
        }

        let mut previous_output = None;
        let mut rendered_steps = Vec::new();
        for step in steps {
            if let Some((label, output)) = self.execute_agent_directive(session_id, step, previous_output.as_deref())? {
                rendered_steps.push(format!("{label}: {output}"));
                previous_output = Some(output);
            }
        }

        Ok((
            format!("tool-chain {spec}"),
            rendered_steps.join("\n"),
        ))
    }

    fn execute_agent_directive(
        &self,
        session_id: &str,
        directive: &str,
        previous_output: Option<&str>,
    ) -> Result<Option<(String, String)>, OctoError> {
        let hydrated = previous_output
            .map(|output| directive.replace("{{prev}}", output))
            .unwrap_or_else(|| String::from(directive));
        let trimmed = hydrated.trim();

        let observation = if let Some(input) = trimmed.strip_prefix("search ") {
            let result = self.run_tool(ToolCall {
                name: String::from("search-text"),
                input: String::from(input.trim()),
                permission: PermissionMode::ReadOnly,
            })?;
            Some((format!("search-text {}", input.trim()), truncate_preview(&result.output, 1200)))
        } else if let Some(input) = trimmed.strip_prefix("read ") {
            let result = self.run_tool(ToolCall {
                name: String::from("read-file"),
                input: String::from(input.trim()),
                permission: PermissionMode::ReadOnly,
            })?;
            Some((format!("read-file {}", input.trim()), truncate_preview(&result.output, 1200)))
        } else if let Some(input) = trimmed.strip_prefix("list ") {
            let result = self.run_tool(ToolCall {
                name: String::from("list-files"),
                input: String::from(input.trim()),
                permission: PermissionMode::ReadOnly,
            })?;
            Some((format!("list-files {}", input.trim()), truncate_preview(&result.output, 1200)))
        } else if trimmed == "provider-strategy" {
            let (strategy, _) = self.build_agent_provider_strategy()?;
            Some((String::from("provider-strategy"), strategy))
        } else if trimmed == "session-plan" {
            Some((
                String::from("session-plan"),
                self.build_session_workspace_plan(session_id, "current task")?,
            ))
        } else {
            None
        };

        Ok(observation)
    }

    fn build_session_workspace_plan(&self, session_id: &str, goal: &str) -> Result<String, OctoError> {
        let session = self.session(session_id)?;
        let recent = session
            .messages
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|message| format!("- {}: {}", message.role.as_str(), truncate_preview(&message.content, 180)))
            .collect::<Vec<_>>();
        let healths = self
            .provider_healths()
            .into_iter()
            .map(|health| format!("{} {:?} healthy={} fail={}", health.provider_id, health.circuit_state, health.healthy, health.failure_count))
            .collect::<Vec<_>>()
            .join(", ");
        Ok([
            format!("goal: {goal}"),
            format!("workspace: {} via {:?}", self.workspace().root, self.workspace().preferred_shell),
            format!("session: {} ({})", session.summary.id, session.summary.title),
            format!("provider-health: {}", if healths.is_empty() { String::from("none") } else { healths }),
            String::from("suggested-tools: list-files -> read-file -> search-text -> workflow-plan"),
            if recent.is_empty() {
                String::from("recent-session: none")
            } else {
                format!("recent-session:\n{}", recent.join("\n"))
            },
        ]
        .join("\n"))
    }

    fn build_agent_provider_strategy(&self) -> Result<(String, bool), OctoError> {
        let status = self.status()?;
        let healths = self.provider_healths();
        let circuits = self.provider_circuits();
        let healthy = healths
            .iter()
            .filter(|health| health.healthy)
            .map(|health| health.provider_id.clone())
            .collect::<Vec<_>>();
        let open_circuits = circuits
            .iter()
            .filter(|circuit| !matches!(circuit.circuit_state, octocode_core::ProviderCircuitState::Closed))
            .map(|circuit| format!("{}:{:?}", circuit.provider_id, circuit.circuit_state))
            .collect::<Vec<_>>();
        let active_healthy = healths
            .iter()
            .find(|health| health.provider_id == status.active_provider_id)
            .map(|health| health.healthy)
            .unwrap_or(false);

        let strategy = [
            format!("active-provider: {}", status.active_provider_id),
            format!(
                "healthy-chain: {}",
                if healthy.is_empty() {
                    String::from("none")
                } else {
                    healthy.join(" -> ")
                }
            ),
            format!(
                "circuit-watch: {}",
                if open_circuits.is_empty() {
                    String::from("all closed")
                } else {
                    open_circuits.join(", ")
                }
            ),
            if active_healthy {
                String::from("dispatch-mode: provider prompt with built-in fallback chain")
            } else if healthy.is_empty() {
                String::from("dispatch-mode: local-only fallback summary")
            } else {
                String::from("dispatch-mode: provider prompt while runtime expects fallback provider promotion")
            },
        ]
        .join("\n");
        Ok((strategy, healthy.is_empty()))
    }

    fn build_agent_fallback(
        &self,
        goal: &str,
        workspace_plan: &str,
        workflow: &str,
        provider_strategy: &str,
        observations: &[(String, String)],
        reason: Option<&str>,
    ) -> String {
        let mut lines = vec![
            format!("agent fallback for: {goal}"),
            String::from("using local orchestration summary"),
            format!("reason: {}", reason.unwrap_or("provider unavailable")),
            String::from("session-plan:"),
            workspace_plan.to_string(),
            String::from("workflow:"),
            workflow.to_string(),
            String::from("provider-strategy:"),
            provider_strategy.to_string(),
        ];
        if observations.is_empty() {
            lines.push(String::from("observations: none"));
        } else {
            lines.push(String::from("observations:"));
            lines.extend(
                observations
                    .iter()
                    .map(|(label, output)| format!("- {label}: {output}")),
            );
        }
        lines.join("\n")
    }
}

fn truncate_preview(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return String::from(value);
    }

    let mut preview = value.chars().take(max_len).collect::<String>();
    preview.push_str(" ...");
    preview
}

fn parse_permission_mode(value: &str) -> PermissionMode {
    match value {
        "read-only" => PermissionMode::ReadOnly,
        "danger-full-access" => PermissionMode::DangerFullAccess,
        _ => PermissionMode::WorkspaceWrite,
    }
}

fn permission_mode_label(mode: &PermissionMode) -> &'static str {
    match mode {
        PermissionMode::ReadOnly => "read-only",
        PermissionMode::WorkspaceWrite => "workspace-write",
        PermissionMode::DangerFullAccess => "danger-full-access",
    }
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

fn option_string_json(value: Option<&str>) -> String {
    value
        .map(|value| format!("\"{}\"", escape_json(value)))
        .unwrap_or_else(|| String::from("null"))
}

fn provider_circuit_event_to_json(event: &ProviderCircuitEvent) -> String {
    format!(
        "{{\"atMs\":{},\"kind\":\"{:?}\",\"detail\":\"{}\"}}",
        event.at_ms,
        event.kind,
        escape_json(&event.detail)
    )
}

fn provider_circuit_to_json(circuit: &ProviderCircuitStatus) -> String {
    format!(
        concat!(
            "{{",
            "\"providerId\":\"{}\",",
            "\"displayName\":\"{}\",",
            "\"circuitState\":\"{:?}\",",
            "\"failureCount\":{},",
            "\"cooldownRemainingMs\":{},",
            "\"recentFailureReason\":{},",
            "\"lastOpenedAtMs\":{},",
            "\"lastHalfOpenedAtMs\":{},",
            "\"lastRecoveredAtMs\":{},",
            "\"eventLog\":[{}]",
            "}}"
        ),
        escape_json(&circuit.provider_id),
        escape_json(&circuit.display_name),
        circuit.circuit_state,
        circuit.failure_count,
        circuit
            .cooldown_remaining_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| String::from("null")),
        option_string_json(circuit.recent_failure_reason.as_deref()),
        circuit
            .last_opened_at_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| String::from("null")),
        circuit
            .last_half_opened_at_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| String::from("null")),
        circuit
            .last_recovered_at_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| String::from("null")),
        circuit
            .event_log
            .iter()
            .map(provider_circuit_event_to_json)
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn provider_route_to_json(route: &ProviderRouteStatus) -> String {
    format!(
        concat!(
            "{{",
            "\"providerId\":\"{}\",",
            "\"displayName\":\"{}\",",
            "\"kind\":\"{:?}\",",
            "\"healthy\":{},",
            "\"circuitState\":\"{:?}\",",
            "\"detail\":\"{}\",",
            "\"latencyMs\":{},",
            "\"isPrimary\":{},",
            "\"isActive\":{}",
            "}}"
        ),
        escape_json(&route.provider_id),
        escape_json(&route.display_name),
        route.kind,
        route.healthy,
        route.circuit_state,
        escape_json(&route.detail),
        route.latency_ms.map(|value| value.to_string()).unwrap_or_else(|| String::from("null")),
        route.is_primary,
        route.is_active
    )
}

fn snapshot_to_json(snapshot: &UiSnapshot) -> String {
    let providers = snapshot
        .providers
        .iter()
        .map(|provider| {
            format!(
                concat!(
                    "{{",
                    "\"id\":\"{}\",",
                    "\"displayName\":\"{}\",",
                    "\"kind\":\"{:?}\",",
                    "\"supportsTools\":{},",
                    "\"supportsStreaming\":{},",
                    "\"capabilities\":{{",
                    "\"chat\":{},",
                    "\"streaming\":{},",
                    "\"toolCalls\":{},",
                    "\"sessionMemory\":{},",
                    "\"jsonOutput\":{}",
                    "}}",
                    "}}"
                ),
                escape_json(&provider.id),
                escape_json(&provider.display_name),
                provider.kind,
                provider.supports_tools,
                provider.supports_streaming,
                provider.capabilities.chat,
                provider.capabilities.streaming,
                provider.capabilities.tool_calls,
                provider.capabilities.session_memory,
                provider.capabilities.json_output
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let commands = snapshot
        .commands
        .iter()
        .map(|command| {
            format!(
                "{{\"name\":\"{}\",\"summary\":\"{}\"}}",
                escape_json(command.name),
                escape_json(command.summary)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let provider_healths = snapshot
        .provider_healths
        .iter()
        .map(|health| {
            format!(
                concat!(
                    "{{",
                    "\"providerId\":\"{}\",",
                    "\"displayName\":\"{}\",",
                    "\"healthy\":{},",
                    "\"detail\":\"{}\",",
                    "\"model\":\"{}\",",
                    "\"latencyMs\":{},",
                    "\"circuitState\":\"{:?}\",",
                    "\"failureCount\":{},",
                    "\"cooldownRemainingMs\":{}",
                    "}}"
                ),
                escape_json(&health.provider_id),
                escape_json(&health.display_name),
                health.healthy,
                escape_json(&health.detail),
                escape_json(health.model.as_deref().unwrap_or("")),
                health
                    .latency_ms
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| String::from("null")),
                health.circuit_state,
                health.failure_count,
                health
                    .cooldown_remaining_ms
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| String::from("null"))
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let provider_circuits = snapshot
        .provider_circuits
        .iter()
        .map(provider_circuit_to_json)
        .collect::<Vec<_>>()
        .join(",");
    let provider_routes = snapshot
        .provider_routes
        .iter()
        .map(provider_route_to_json)
        .collect::<Vec<_>>()
        .join(",");
    let tools = snapshot
        .tools
        .iter()
        .map(|tool| {
            format!(
                "{{\"name\":\"{}\",\"summary\":\"{}\",\"minimumPermission\":\"{:?}\"}}",
                escape_json(tool.name),
                escape_json(tool.summary),
                tool.minimum_permission
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let sessions = snapshot
        .sessions
        .iter()
        .map(|session| {
            format!(
                "{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}}",
                escape_json(&session.id),
                escape_json(&session.title),
                escape_json(session.model.as_deref().unwrap_or(""))
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let active_session = snapshot.active_session.as_ref().map(|session| {
        let messages = session
            .messages
            .iter()
            .map(|message| {
                format!(
                    "{{\"role\":\"{}\",\"content\":\"{}\"}}",
                    message.role.as_str(),
                    escape_json(&message.content)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"summary\":{{\"id\":\"{}\",\"title\":\"{}\",\"model\":\"{}\"}},\"messages\":[{}]}}",
            escape_json(&session.summary.id),
            escape_json(&session.summary.title),
            escape_json(session.summary.model.as_deref().unwrap_or("")),
            messages
        )
    });

    format!(
        concat!(
            "{{",
            "\"status\":{{",
            "\"providerId\":\"{}\",",
            "\"activeProviderId\":\"{}\",",
            "\"providerKind\":\"{:?}\",",
            "\"platform\":\"{:?}\",",
            "\"permissionMode\":\"{:?}\",",
            "\"sessionCount\":{},",
            "\"providerHealth\":{{",
            "\"providerId\":\"{}\",",
            "\"displayName\":\"{}\",",
            "\"healthy\":{},",
            "\"detail\":\"{}\",",
            "\"model\":\"{}\",",
            "\"latencyMs\":{},",
            "\"circuitState\":\"{:?}\",",
            "\"failureCount\":{},",
            "\"cooldownRemainingMs\":{}",
            "}}",
            ",\"providerCircuit\":{}",
            ",\"providerRoutes\":[{}]",
            "}},",
            "\"workspace\":{{",
            "\"root\":\"{}\",",
            "\"platform\":\"{:?}\",",
            "\"shell\":\"{:?}\"",
            "}},",
            "\"config\":{{",
            "\"providerId\":\"{}\",",
            "\"providerBaseUrl\":\"{}\",",
            "\"defaultModel\":\"{}\",",
            "\"permissionMode\":\"{:?}\",",
            "\"historyLimit\":{}",
            "}},",
            "\"providers\":[{}],",
            "\"providerHealths\":[{}],",
            "\"providerCircuits\":[{}],",
            "\"providerRoutes\":[{}],",
            "\"commands\":[{}],",
            "\"tools\":[{}],",
            "\"sessions\":[{}],",
            "\"activeSession\":{}",
            "}}"
        ),
        escape_json(&snapshot.status.provider_id),
        escape_json(&snapshot.status.active_provider_id),
        snapshot.status.provider_kind,
        snapshot.status.platform,
        snapshot.status.permission_mode,
        snapshot.status.session_count,
        escape_json(&snapshot.status.provider_health.provider_id),
        escape_json(&snapshot.status.provider_health.display_name),
        snapshot.status.provider_health.healthy,
        escape_json(&snapshot.status.provider_health.detail),
        escape_json(snapshot.status.provider_health.model.as_deref().unwrap_or("")),
        snapshot
            .status
            .provider_health
            .latency_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| String::from("null")),
        snapshot.status.provider_health.circuit_state,
        snapshot.status.provider_health.failure_count,
        snapshot
            .status
            .provider_health
            .cooldown_remaining_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| String::from("null")),
        provider_circuit_to_json(&snapshot.status.provider_circuit),
        snapshot
            .status
            .provider_routes
            .iter()
            .map(provider_route_to_json)
            .collect::<Vec<_>>()
            .join(","),
        escape_json(&snapshot.workspace.root),
        snapshot.workspace.platform,
        snapshot.workspace.preferred_shell,
        escape_json(snapshot.config.provider_id.as_deref().unwrap_or("")),
        escape_json(snapshot.config.provider_base_url.as_deref().unwrap_or("")),
        escape_json(snapshot.config.default_model.as_deref().unwrap_or("")),
        snapshot.config.permission_mode,
        snapshot.config.history_limit,
        providers,
        provider_healths,
        provider_circuits,
        provider_routes,
        commands,
        tools,
        sessions,
        active_session.unwrap_or_else(|| String::from("null"))
    )
}

#[cfg(test)]
mod tests {
    use super::RuntimePermissionPolicy;
    use crate::tools::NativeShellInvocation;
    use octocode_core::{PermissionMode, PermissionPolicy, ShellKind};

    #[test]
    fn permission_policy_rejects_write_from_read_only() {
        let policy = RuntimePermissionPolicy;
        assert!(policy
            .ensure_allowed(
                &PermissionMode::ReadOnly,
                &PermissionMode::WorkspaceWrite,
                "tool write-file"
            )
            .is_err());
    }

    #[test]
    fn permission_policy_allows_escalation_downward() {
        let policy = RuntimePermissionPolicy;
        assert!(policy
            .ensure_allowed(
                &PermissionMode::DangerFullAccess,
                &PermissionMode::ReadOnly,
                "tool read-file"
            )
            .is_ok());
    }

    #[test]
    fn non_windows_shell_invocation_uses_login_shell_flags() {
        if cfg!(target_os = "windows") {
            return;
        }

        let invocation = NativeShellInvocation::detect(&ShellKind::Bash, "printf ok");
        assert_eq!(invocation.args.len(), 2);
        assert_eq!(invocation.args[0], "-lc");
        assert_eq!(invocation.args[1], "printf ok");
    }
}
