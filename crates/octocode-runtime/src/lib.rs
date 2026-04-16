use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use octocode_core::{
    CommandDescriptor, ConfigPaths, ConversationMessage, ConversationRole, ConversationSession,
    ConversationStore, DoctorReport, ModelProvider, OctoError, PermissionMode, PlatformKind,
    PlatformSupport, PromptRequest, PromptResponse, ProviderDescriptor, RuntimeConfig,
    RuntimeStatus, SessionStore, SessionSummary, ShellKind, ToolCall, ToolDescriptor,
    ToolExecutor, ToolResult, UiSnapshot, WorkspaceContext,
};

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
        fs::create_dir_all(&transcripts_dir)
            .map_err(|error| OctoError::Session(format!("failed to create transcripts dir: {error}")))?;
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
        let raw = fs::read_to_string(&path)
            .map_err(|error| OctoError::Session(format!("failed to read session file {}: {error}", path.display())))?;
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

        sessions.sort_by(|left, right| left.id.cmp(&right.id));
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
        let transcript_path = self.transcript_file_path(id);
        let raw = fs::read_to_string(&transcript_path).unwrap_or_default();
        let messages = raw
            .lines()
            .filter_map(|line| {
                let (role, content) = line.split_once('\t')?;
                Some(ConversationMessage {
                    role: ConversationRole::parse(role),
                    content: content.replace("\\n", "\n"),
                })
            })
            .collect();
        Ok(ConversationSession { summary, messages })
    }

    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError> {
        let transcript_path = self.transcript_file_path(session_id);
        if let Some(parent) = transcript_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                OctoError::Session(format!("failed to create transcript dir {}: {error}", parent.display()))
            })?;
        }
        let line = format!(
            "{}\t{}\n",
            message.role.as_str(),
            message.content.replace('\n', "\\n")
        );
        let mut existing = fs::read_to_string(&transcript_path).unwrap_or_default();
        existing.push_str(&line);
        fs::write(&transcript_path, existing).map_err(|error| {
            OctoError::Session(format!("failed to write transcript {}: {error}", transcript_path.display()))
        })
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
                let path = self.resolve_workspace_path(if call.input.trim().is_empty() { "." } else { &call.input });
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
        let path = PathBuf::from(&self.paths.config_home).join("octocode.conf");
        if !path.is_file() {
            return Ok(RuntimeConfig {
                provider_id: None,
                default_model: None,
                permission_mode: PermissionMode::WorkspaceWrite,
            });
        }

        let raw = fs::read_to_string(&path)
            .map_err(|error| OctoError::Runtime(format!("failed to read config {}: {error}", path.display())))?;

        let mut provider_id = None;
        let mut default_model = None;
        let mut permission_mode = PermissionMode::WorkspaceWrite;

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
                        provider_id = Some(String::from(value));
                    }
                }
                "default_model" => {
                    let value = value.trim();
                    if !value.is_empty() {
                        default_model = Some(String::from(value));
                    }
                }
                "permission_mode" => {
                    permission_mode = match value.trim() {
                        "read-only" => PermissionMode::ReadOnly,
                        "danger-full-access" => PermissionMode::DangerFullAccess,
                        _ => PermissionMode::WorkspaceWrite,
                    };
                }
                _ => {}
            }
        }

        Ok(RuntimeConfig {
            provider_id,
            default_model,
            permission_mode,
        })
    }

    pub fn ensure_default_file(&self) -> Result<PathBuf, OctoError> {
        let path = PathBuf::from(&self.paths.config_home).join("octocode.conf");
        if !path.is_file() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    OctoError::Runtime(format!("failed to create config dir {}: {error}", parent.display()))
                })?;
            }
            fs::write(
                &path,
                "# Octocode config\nprovider_id=local-echo\npermission_mode=workspace-write\ndefault_model=octocode-default\n",
            )
            .map_err(|error| {
                OctoError::Runtime(format!("failed to write config {}: {error}", path.display()))
            })?;
        }
        Ok(path)
    }

    pub fn config_file_path(&self) -> PathBuf {
        PathBuf::from(&self.paths.config_home).join("octocode.conf")
    }
}

const COMMANDS: &[CommandDescriptor] = &[
    CommandDescriptor { name: "prompt", summary: "Run a one-shot prompt" },
    CommandDescriptor { name: "chat", summary: "Append a user turn into a session" },
    CommandDescriptor { name: "sessions", summary: "List local sessions" },
    CommandDescriptor { name: "session-show", summary: "Show one session transcript" },
    CommandDescriptor { name: "session-add", summary: "Persist a local session" },
    CommandDescriptor { name: "session-export", summary: "Export local sessions to a file" },
    CommandDescriptor { name: "tool", summary: "Run a built-in tool" },
    CommandDescriptor { name: "tools", summary: "List built-in tool descriptors" },
    CommandDescriptor { name: "workspace", summary: "Show workspace platform context" },
    CommandDescriptor { name: "providers", summary: "List configured provider surfaces" },
    CommandDescriptor { name: "doctor", summary: "Show platform and config diagnostics" },
    CommandDescriptor { name: "status", summary: "Show effective runtime status" },
    CommandDescriptor { name: "permissions", summary: "Show or set effective permission mode" },
    CommandDescriptor { name: "config-init", summary: "Create the default config file" },
    CommandDescriptor { name: "config-show", summary: "Inspect the current config file" },
    CommandDescriptor { name: "ui-export", summary: "Export UI state snapshot into a JSON file" },
    CommandDescriptor { name: "commands", summary: "List the current CLI command surface" },
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
                let app_data = std::env::var("APPDATA").unwrap_or_else(|_| format!("{user_profile}\\AppData\\Roaming"));
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
            .unwrap_or(RuntimeConfig {
                provider_id: None,
                default_model: None,
                permission_mode: PermissionMode::WorkspaceWrite,
            });
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
        if !self
            .sessions
            .list_sessions()?
            .iter()
            .any(|session| session.id == session_id)
        {
            self.sessions.save_session(SessionSummary {
                id: String::from(session_id),
                title: format!("Session {session_id}"),
                model: self.config.default_model.clone(),
            })?;
        }

        self.sessions.append_message(
            session_id,
            ConversationMessage {
                role: ConversationRole::User,
                content: String::from(text),
            },
        )?;

        let response = self.provider.prompt(PromptRequest {
            text: String::from(text),
            model: self.config.default_model.clone(),
        })?;

        self.sessions.append_message(
            session_id,
            ConversationMessage {
                role: ConversationRole::Assistant,
                content: response.output.clone(),
            },
        )?;

        Ok(response)
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
        }
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

    pub fn status(&self) -> Result<RuntimeStatus, OctoError> {
        let provider = self.provider.descriptor();
        Ok(RuntimeStatus {
            provider_id: provider.id,
            provider_kind: provider.kind,
            platform: self.platform.context().platform.clone(),
            permission_mode: self.config.permission_mode.clone(),
            session_count: self.sessions.list_sessions()?.len(),
        })
    }

    pub fn export_sessions(&self, path: impl Into<PathBuf>) -> Result<PathBuf, OctoError> {
        let path = path.into();
        let sessions = self.sessions()?;
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|error| {
                    OctoError::Session(format!("failed to create export dir {}: {error}", parent.display()))
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
                OctoError::Session(format!("failed to write export file {}: {error}", path.display()))
            })?;
        Ok(path)
    }

    pub fn snapshot(&self, active_session_id: Option<&str>) -> Result<UiSnapshot, OctoError> {
        Ok(UiSnapshot {
            status: self.status()?,
            workspace: self.workspace().clone(),
            config: self.config.clone(),
            providers: self.providers().to_vec(),
            commands: self.commands().to_vec(),
            tools: self.tools().to_vec(),
            sessions: self.sessions()?,
            active_session: match active_session_id {
                Some(id) => Some(self.session(id)?),
                None => None,
            },
        })
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
                    OctoError::Runtime(format!("failed to create UI export dir {}: {error}", parent.display()))
                })?;
            }
        }
        let snapshot = self.snapshot(active_session_id)?;
        fs::write(&path, snapshot_to_json(&snapshot)).map_err(|error| {
            OctoError::Runtime(format!("failed to write UI state {}: {error}", path.display()))
        })?;
        Ok(path)
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

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
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
            "\"providerKind\":\"{:?}\",",
            "\"platform\":\"{:?}\",",
            "\"permissionMode\":\"{:?}\",",
            "\"sessionCount\":{}",
            "}},",
            "\"workspace\":{{",
            "\"root\":\"{}\",",
            "\"platform\":\"{:?}\",",
            "\"shell\":\"{:?}\"",
            "}},",
            "\"config\":{{",
            "\"providerId\":\"{}\",",
            "\"defaultModel\":\"{}\",",
            "\"permissionMode\":\"{:?}\"",
            "}},",
            "\"providers\":[{}],",
            "\"commands\":[{}],",
            "\"tools\":[{}],",
            "\"sessions\":[{}],",
            "\"activeSession\":{}",
            "}}"
        ),
        escape_json(&snapshot.status.provider_id),
        snapshot.status.provider_kind,
        snapshot.status.platform,
        snapshot.status.permission_mode,
        snapshot.status.session_count,
        escape_json(&snapshot.workspace.root),
        snapshot.workspace.platform,
        snapshot.workspace.preferred_shell,
        escape_json(snapshot.config.provider_id.as_deref().unwrap_or("")),
        escape_json(snapshot.config.default_model.as_deref().unwrap_or("")),
        snapshot.config.permission_mode,
        providers,
        commands,
        tools,
        sessions,
        active_session.unwrap_or_else(|| String::from("null"))
    )
}
