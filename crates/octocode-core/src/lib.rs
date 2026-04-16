#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformKind {
    Windows,
    MacOs,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderKind {
    Stub,
    Anthropic,
    OpenAiCompatible,
    XAi,
    DashScope,
    Ollama,
    LlamaCpp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellKind {
    PowerShell,
    Cmd,
    Zsh,
    Bash,
    Sh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationRole {
    System,
    User,
    Assistant,
}

impl ConversationRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "system" => Self::System,
            "assistant" => Self::Assistant,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContext {
    pub root: String,
    pub platform: PlatformKind,
    pub preferred_shell: ShellKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationMessage {
    pub role: ConversationRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationSession {
    pub summary: SessionSummary,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRequest {
    pub text: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptResponse {
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: String,
    pub display_name: String,
    pub kind: ProviderKind,
    pub supports_tools: bool,
    pub supports_streaming: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPaths {
    pub config_home: String,
    pub cache_home: String,
    pub data_home: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub provider_id: Option<String>,
    pub default_model: Option<String>,
    pub permission_mode: PermissionMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub provider_id: String,
    pub provider_kind: ProviderKind,
    pub platform: PlatformKind,
    pub permission_mode: PermissionMode,
    pub session_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorReport {
    pub workspace: WorkspaceContext,
    pub paths: ConfigPaths,
    pub config: RuntimeConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandDescriptor {
    pub name: &'static str,
    pub summary: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub summary: &'static str,
    pub minimum_permission: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub name: String,
    pub input: String,
    pub permission: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiSnapshot {
    pub status: RuntimeStatus,
    pub workspace: WorkspaceContext,
    pub config: RuntimeConfig,
    pub providers: Vec<ProviderDescriptor>,
    pub commands: Vec<CommandDescriptor>,
    pub tools: Vec<ToolDescriptor>,
    pub sessions: Vec<SessionSummary>,
    pub active_session: Option<ConversationSession>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OctoError {
    Provider(String),
    Session(String),
    Runtime(String),
}

pub trait ModelProvider: Send + Sync {
    fn descriptor(&self) -> ProviderDescriptor;
    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError>;
}

pub trait SessionStore: Send + Sync {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError>;
    fn save_session(&self, session: SessionSummary) -> Result<(), OctoError>;
}

pub trait ConversationStore: SessionStore + Send + Sync {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError>;
    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError>;
}

pub trait ToolExecutor: Send + Sync {
    fn execute(&self, call: ToolCall) -> Result<ToolResult, OctoError>;
}

pub trait PlatformSupport: Send + Sync {
    fn context(&self) -> &WorkspaceContext;
    fn config_paths(&self) -> ConfigPaths;
}

impl std::fmt::Display for OctoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Provider(message) => write!(formatter, "provider error: {message}"),
            Self::Session(message) => write!(formatter, "session error: {message}"),
            Self::Runtime(message) => write!(formatter, "runtime error: {message}"),
        }
    }
}

impl std::error::Error for OctoError {}
