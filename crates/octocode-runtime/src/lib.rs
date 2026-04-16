use octocode_core::{
    ConfigPaths, ModelProvider, OctoError, PlatformKind, PlatformSupport, PromptRequest,
    PromptResponse, SessionStore, SessionSummary, ShellKind, ToolCall, ToolExecutor, ToolResult,
    WorkspaceContext,
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

pub struct NativePlatform {
    context: WorkspaceContext,
}

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
}

impl<P, S, T> OctocodeRuntime<P, S, T>
where
    P: ModelProvider,
    S: SessionStore,
    T: ToolExecutor,
{
    pub fn new(provider: P, sessions: S, tools: T, workspace: WorkspaceContext) -> Self {
        Self {
            provider,
            sessions,
            tools,
            platform: NativePlatform { context: workspace },
        }
    }

    pub fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        self.provider.prompt(request)
    }

    pub fn sessions(&self) -> Result<Vec<SessionSummary>, OctoError> {
        self.sessions.list_sessions()
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
}
