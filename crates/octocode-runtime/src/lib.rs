use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use octocode_core::{
    CommandDescriptor, ConfigPaths, ConversationMessage, ConversationRole, ConversationSession,
    ConversationStore, DoctorReport, ModelProvider, OctoError, PermissionMode, PlatformKind,
    PlatformSupport, PromptRequest, PromptResponse, ProviderCircuitEvent,
    ProviderCircuitStatus, ProviderDescriptor, ProviderHealth, RuntimeConfig, RuntimeStatus,
    SessionStore, SessionSummary, ShellKind, ToolCall, ToolDescriptor, ToolExecutor, ToolResult,
    UiSnapshot, WorkspaceContext,
};

const DEFAULT_PROVIDER_ID: &str = "local-openai";
const DEFAULT_PROVIDER_BASE_URL: &str = "http://192.168.110.2:8000/v1";
const DEFAULT_MODEL: &str = "gemma-4-31b-it-q8-prod";
const DEFAULT_HISTORY_LIMIT: usize = 24;

#[derive(Default)]
pub struct MemorySessionStore {
    sessions: Vec<SessionSummary>,
}

impl MemorySessionStore {
    pub fn new() -> Self {
        Self {
            sessions: vec![SessionSummary {
                id: String::from("bootstrap"),
                title: String::from("Bootstrap Session"),
                model: None,
            }],
        }
    }
}

impl SessionStore for MemorySessionStore {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        Ok(self.sessions.clone())
    }

    fn save_session(&self, _session: SessionSummary) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist sessions",
        )))
    }
}

impl ConversationStore for MemorySessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        let summary = self
            .sessions
            .iter()
            .find(|session| session.id == id)
            .cloned()
            .ok_or_else(|| OctoError::Session(format!("unknown session: {id}")))?;
        Ok(ConversationSession {
            summary,
            messages: Vec::new(),
        })
    }

    fn append_message(&self, _session_id: &str, _message: ConversationMessage) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist messages",
        )))
    }

    fn replace_messages(
        &self,
        _session_id: &str,
        _messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError> {
        Err(OctoError::Session(String::from(
            "memory session store does not persist messages",
        )))
    }

    fn latest_session_id(&self) -> Result<Option<String>, OctoError> {
        Ok(self.sessions.last().map(|session| session.id.clone()))
    }
}

pub struct FileSessionStore {
    sessions_dir: PathBuf,
    transcripts_dir: PathBuf,
}

impl FileSessionStore {
    pub fn new(paths: &ConfigPaths) -> Result<Self, OctoError> {
        let sessions_dir = PathBuf::from(&paths.data_home).join("sessions");
        let transcripts_dir = PathBuf::from(&paths.data_home).join("transcripts");
        fs::create_dir_all(&sessions_dir)
            .map_err(|error| OctoError::Session(format!("failed to create sessions dir: {error}")))?;
        fs::create_dir_all(&transcripts_dir).map_err(|error| {
            OctoError::Session(format!("failed to create transcripts dir: {error}"))
        })?;
        Ok(Self {
            sessions_dir,
            transcripts_dir,
        })
    }

    fn session_file_path(&self, id: &str) -> PathBuf {
        self.sessions_dir.join(format!("{id}.session"))
    }

    fn transcript_file_path(&self, id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{id}.messages"))
    }

    fn load_summary(&self, id: &str) -> Result<SessionSummary, OctoError> {
        let path = self.session_file_path(id);
        let raw = fs::read_to_string(&path).map_err(|error| {
            OctoError::Session(format!("failed to read session file {}: {error}", path.display()))
        })?;
        let mut parts = raw.lines();
        let id = parts.next().unwrap_or_default().trim().to_string();
        let title = parts.next().unwrap_or_default().trim().to_string();
        let model = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if id.is_empty() {
            return Err(OctoError::Session(String::from("session id is empty")));
        }
        Ok(SessionSummary { id, title, model })
    }

    fn load_messages(&self, id: &str) -> Vec<ConversationMessage> {
        let transcript_path = self.transcript_file_path(id);
        let raw = fs::read_to_string(&transcript_path).unwrap_or_default();
        raw.lines()
            .filter_map(|line| {
                let (role, content) = line.split_once('\t')?;
                Some(ConversationMessage {
                    role: ConversationRole::parse(role),
                    content: content.replace("\\n", "\n"),
                })
            })
            .collect()
    }

    fn write_messages(&self, id: &str, messages: &[ConversationMessage]) -> Result<(), OctoError> {
        let transcript_path = self.transcript_file_path(id);
        if let Some(parent) = transcript_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Session(format!(
                    "failed to create transcript dir {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let body = messages
            .iter()
            .map(|message| {
                format!(
                    "{}\t{}",
                    message.role.as_str(),
                    message.content.replace('\n', "\\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let normalized = if body.is_empty() {
            String::new()
        } else {
            format!("{body}\n")
        };

        fs::write(&transcript_path, normalized).map_err(|error| {
            OctoError::Session(format!(
                "failed to write transcript {}: {error}",
                transcript_path.display()
            ))
        })
    }

    fn last_modified_for(&self, id: &str) -> Option<SystemTime> {
        let transcript_path = self.transcript_file_path(id);
        let session_path = self.session_file_path(id);
        transcript_path
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .or_else(|| session_path.metadata().and_then(|meta| meta.modified()).ok())
    }
}

impl SessionStore for FileSessionStore {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        let mut sessions = Vec::new();
        let entries = fs::read_dir(&self.sessions_dir)
            .map_err(|error| OctoError::Session(format!("failed to read sessions dir: {error}")))?;

        for entry in entries {
            let entry = entry
                .map_err(|error| OctoError::Session(format!("failed to read session entry: {error}")))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("session") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            sessions.push(self.load_summary(id)?);
        }

        sessions.sort_by(|left, right| right.id.cmp(&left.id));
        Ok(sessions)
    }

    fn save_session(&self, session: SessionSummary) -> Result<(), OctoError> {
        let file_path = self.session_file_path(&session.id);
        let body = format!(
            "{}\n{}\n{}\n",
            session.id,
            session.title,
            session.model.unwrap_or_default()
        );
        fs::write(file_path, body)
            .map_err(|error| OctoError::Session(format!("failed to write session file: {error}")))
    }
}

impl ConversationStore for FileSessionStore {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError> {
        let summary = self.load_summary(id)?;
        Ok(ConversationSession {
            summary,
            messages: self.load_messages(id),
        })
    }

    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError> {
        let mut messages = self.load_messages(session_id);
        messages.push(message);
        self.write_messages(session_id, &messages)
    }

    fn replace_messages(
        &self,
        session_id: &str,
        messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError> {
        self.write_messages(session_id, &messages)
    }

    fn latest_session_id(&self) -> Result<Option<String>, OctoError> {
        let sessions = self.list_sessions()?;
        let latest = sessions
            .iter()
            .max_by_key(|session| self.last_modified_for(&session.id))
            .map(|session| session.id.clone());
        Ok(latest)
    }
}

pub struct WorkspaceToolExecutor {
    workspace_root: PathBuf,
}

impl WorkspaceToolExecutor {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
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
        let output = if cfg!(target_os = "windows") {
            Command::new("powershell")
                .args(["-NoProfile", "-Command", command_line])
                .current_dir(&self.workspace_root)
                .output()
        } else {
            Command::new("bash")
                .args(["-lc", command_line])
                .current_dir(&self.workspace_root)
                .output()
        }
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
        summary: "Append an agent action stub into the current session",
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
        name: "doctor",
        summary: "Show platform and config diagnostics",
    },
    CommandDescriptor {
        name: "status",
        summary: "Show effective runtime status",
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
        summary: "Draft a concrete next action set for the current session",
        minimum_permission: PermissionMode::ReadOnly,
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

    pub fn run_tool_in_session(
        &self,
        session_id: &str,
        mut call: ToolCall,
    ) -> Result<ToolResult, OctoError> {
        self.ensure_session_exists(session_id)?;
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

    pub fn tools(&self) -> &'static [ToolDescriptor] {
        TOOLS
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
        }
    }

    pub fn provider_healths(&self) -> Vec<ProviderHealth> {
        self.provider.health_catalog()
    }

    pub fn provider_circuits(&self) -> Vec<ProviderCircuitStatus> {
        self.provider.circuit_catalog()
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

    fn tool_descriptor(&self, name: &str) -> Option<&'static ToolDescriptor> {
        TOOLS.iter().find(|descriptor| descriptor.name == name)
    }

    fn ensure_permission(&self, requested: &PermissionMode, tool_name: &str) -> Result<(), OctoError> {
        if permission_rank(&self.config.permission_mode) >= permission_rank(requested) {
            Ok(())
        } else {
            Err(OctoError::Runtime(format!(
                "permission denied for tool {tool_name}: required {:?}, current {:?}",
                requested, self.config.permission_mode
            )))
        }
    }
}

fn permission_rank(mode: &PermissionMode) -> u8 {
    match mode {
        PermissionMode::ReadOnly => 0,
        PermissionMode::WorkspaceWrite => 1,
        PermissionMode::DangerFullAccess => 2,
    }
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

fn snapshot_to_json(snapshot: &UiSnapshot) -> String {
    let providers = snapshot
        .providers
        .iter()
        .map(|provider| {
            format!(
                "{{\"id\":\"{}\",\"displayName\":\"{}\",\"kind\":\"{:?}\",\"supportsTools\":{},\"supportsStreaming\":{}}}",
                escape_json(&provider.id),
                escape_json(&provider.display_name),
                provider.kind,
                provider.supports_tools,
                provider.supports_streaming
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
        commands,
        tools,
        sessions,
        active_session.unwrap_or_else(|| String::from("null"))
    )
}
