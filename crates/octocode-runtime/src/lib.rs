use std::fs;
use std::path::{Path, PathBuf};

use octocode_core::{
    CommandDescriptor, ConfigPaths, ModelProvider, OctoError, PermissionMode, PlatformKind,
    PlatformSupport, PromptRequest, PromptResponse, RuntimeConfig, SessionStore, SessionSummary,
    ShellKind, ToolCall, ToolExecutor, ToolResult, WorkspaceContext,
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

#[derive(Default)]
pub struct EchoToolExecutor;

impl ToolExecutor for EchoToolExecutor {
    fn execute(&self, call: ToolCall) -> Result<ToolResult, OctoError> {
        Ok(ToolResult {
            output: format!("tool {} => {}", call.name, call.input),
        })
    }
}

pub struct FileSessionStore {
    sessions_dir: PathBuf,
}

impl FileSessionStore {
    pub fn new(paths: &ConfigPaths) -> Result<Self, OctoError> {
        let sessions_dir = PathBuf::from(&paths.data_home).join("sessions");
        fs::create_dir_all(&sessions_dir)
            .map_err(|error| OctoError::Session(format!("failed to create sessions dir: {error}")))?;
        Ok(Self { sessions_dir })
    }

    fn session_file_path(&self, id: &str) -> PathBuf {
        self.sessions_dir.join(format!("{id}.session"))
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

            let raw = fs::read_to_string(&path)
                .map_err(|error| OctoError::Session(format!("failed to read session file: {error}")))?;
            let mut parts = raw.lines();
            let id = parts.next().unwrap_or_default().trim().to_string();
            let title = parts.next().unwrap_or_default().trim().to_string();
            let model = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);

            if !id.is_empty() {
                sessions.push(SessionSummary { id, title, model });
            }
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
                default_model: None,
                permission_mode: PermissionMode::WorkspaceWrite,
            });
        }

        let raw = fs::read_to_string(&path)
            .map_err(|error| OctoError::Runtime(format!("failed to read config {}: {error}", path.display())))?;

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
            fs::write(&path, "# Octocode config\npermission_mode=workspace-write\n")
                .map_err(|error| {
                    OctoError::Runtime(format!("failed to write config {}: {error}", path.display()))
                })?;
        }
        Ok(path)
    }
}

const COMMANDS: &[CommandDescriptor] = &[
    CommandDescriptor { name: "prompt", summary: "Run a one-shot prompt" },
    CommandDescriptor { name: "sessions", summary: "List local sessions" },
    CommandDescriptor { name: "session-add", summary: "Persist a local session" },
    CommandDescriptor { name: "tool", summary: "Run a built-in tool" },
    CommandDescriptor { name: "workspace", summary: "Show workspace platform context" },
    CommandDescriptor { name: "providers", summary: "List configured provider surfaces" },
    CommandDescriptor { name: "doctor", summary: "Show platform and config diagnostics" },
    CommandDescriptor { name: "status", summary: "Show effective runtime status" },
    CommandDescriptor { name: "permissions", summary: "Show or set effective permission mode" },
    CommandDescriptor { name: "config-init", summary: "Create the default config file" },
    CommandDescriptor { name: "commands", summary: "List the current CLI command surface" },
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
}

impl<P, S, T> OctocodeRuntime<P, S, T>
where
    P: ModelProvider,
    S: SessionStore,
    T: ToolExecutor,
{
    pub fn new(provider: P, sessions: S, tools: T, workspace: WorkspaceContext) -> Self {
        let platform = NativePlatform { context: workspace };
        let config = ConfigLoader::new(platform.config_paths())
            .load()
            .unwrap_or(RuntimeConfig {
                default_model: None,
                permission_mode: PermissionMode::WorkspaceWrite,
            });
        Self {
            provider,
            sessions,
            tools,
            platform,
            config,
        }
    }

    pub fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        self.provider.prompt(request)
    }

    pub fn sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        self.sessions.list_sessions()
    }

    pub fn save_session(&self, session: SessionSummary) -> Result<(), OctoError> {
        self.sessions.save_session(session)
    }

    pub fn run_tool(&self, call: ToolCall) -> Result<ToolResult, OctoError> {
        self.tools.execute(call)
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

    pub fn commands(&self) -> &'static [CommandDescriptor] {
        COMMANDS
    }

    pub fn init_config(&self) -> Result<PathBuf, OctoError> {
        ConfigLoader::new(self.platform.config_paths()).ensure_default_file()
    }

    pub fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.config.permission_mode = mode;
    }
}
