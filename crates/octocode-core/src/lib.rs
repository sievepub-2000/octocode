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
pub struct ProviderCapabilities {
    pub chat: bool,
    pub streaming: bool,
    pub tool_calls: bool,
    pub session_memory: bool,
    pub json_output: bool,
}

impl ProviderCapabilities {
    pub fn stub() -> Self {
        Self {
            chat: true,
            streaming: false,
            tool_calls: false,
            session_memory: false,
            json_output: false,
        }
    }

    pub fn compatible(streaming: bool, tool_calls: bool) -> Self {
        Self {
            chat: true,
            streaming,
            tool_calls,
            session_memory: false,
            json_output: true,
        }
    }
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
    Tool,
}

impl ConversationRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "system" => Self::System,
            "assistant" => Self::Assistant,
            "tool" => Self::Tool,
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
    pub capabilities: ProviderCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHealth {
    pub provider_id: String,
    pub display_name: String,
    pub healthy: bool,
    pub detail: String,
    pub model: Option<String>,
    pub latency_ms: Option<u128>,
    pub circuit_state: ProviderCircuitState,
    pub failure_count: u32,
    pub cooldown_remaining_ms: Option<u128>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderCircuitState {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderCircuitEventKind {
    Failure,
    Opened,
    HalfOpen,
    Recovered,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCircuitEvent {
    pub at_ms: u128,
    pub kind: ProviderCircuitEventKind,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCircuitStatus {
    pub provider_id: String,
    pub display_name: String,
    pub circuit_state: ProviderCircuitState,
    pub failure_count: u32,
    pub cooldown_remaining_ms: Option<u128>,
    pub recent_failure_reason: Option<String>,
    pub last_opened_at_ms: Option<u128>,
    pub last_half_opened_at_ms: Option<u128>,
    pub last_recovered_at_ms: Option<u128>,
    pub event_log: Vec<ProviderCircuitEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRouteStatus {
    pub provider_id: String,
    pub display_name: String,
    pub kind: ProviderKind,
    pub healthy: bool,
    pub circuit_state: ProviderCircuitState,
    pub detail: String,
    pub latency_ms: Option<u128>,
    pub is_primary: bool,
    pub is_active: bool,
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
    pub provider_base_url: Option<String>,
    pub default_model: Option<String>,
    pub permission_mode: PermissionMode,
    pub history_limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub provider_id: String,
    pub active_provider_id: String,
    pub provider_kind: ProviderKind,
    pub platform: PlatformKind,
    pub permission_mode: PermissionMode,
    pub session_count: usize,
    pub provider_health: ProviderHealth,
    pub provider_circuit: ProviderCircuitStatus,
    pub provider_routes: Vec<ProviderRouteStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorReport {
    pub workspace: WorkspaceContext,
    pub paths: ConfigPaths,
    pub config: RuntimeConfig,
    pub provider_healths: Vec<ProviderHealth>,
    pub provider_circuits: Vec<ProviderCircuitStatus>,
    pub provider_routes: Vec<ProviderRouteStatus>,
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
pub struct RuntimeEvent {
    pub scope: String,
    pub message: String,
    pub at_ms: Option<u128>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiSnapshot {
    pub status: RuntimeStatus,
    pub workspace: WorkspaceContext,
    pub config: RuntimeConfig,
    pub providers: Vec<ProviderDescriptor>,
    pub provider_healths: Vec<ProviderHealth>,
    pub provider_circuits: Vec<ProviderCircuitStatus>,
    pub provider_routes: Vec<ProviderRouteStatus>,
    pub commands: Vec<CommandDescriptor>,
    pub tools: Vec<ToolDescriptor>,
    pub sessions: Vec<SessionSummary>,
    pub active_session: Option<ConversationSession>,
    pub event_feed: Vec<RuntimeEvent>,
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

    fn active_provider_id(&self) -> String {
        self.descriptor().id
    }

    fn health(&self) -> ProviderHealth {
        let descriptor = self.descriptor();
        ProviderHealth {
            provider_id: descriptor.id,
            display_name: descriptor.display_name,
            healthy: true,
            detail: String::from("ready"),
            model: None,
            latency_ms: None,
            circuit_state: ProviderCircuitState::Closed,
            failure_count: 0,
            cooldown_remaining_ms: None,
        }
    }

    fn health_catalog(&self) -> Vec<ProviderHealth> {
        vec![self.health()]
    }

    fn circuit_status(&self) -> ProviderCircuitStatus {
        let health = self.health();
        ProviderCircuitStatus {
            provider_id: health.provider_id.clone(),
            display_name: health.display_name.clone(),
            circuit_state: health.circuit_state.clone(),
            failure_count: health.failure_count,
            cooldown_remaining_ms: health.cooldown_remaining_ms,
            recent_failure_reason: if health.detail == "ready" {
                None
            } else {
                Some(health.detail)
            },
            last_opened_at_ms: None,
            last_half_opened_at_ms: None,
            last_recovered_at_ms: None,
            event_log: Vec::new(),
        }
    }

    fn circuit_catalog(&self) -> Vec<ProviderCircuitStatus> {
        vec![self.circuit_status()]
    }

    fn route_statuses(&self) -> Vec<ProviderRouteStatus> {
        let descriptor = self.descriptor();
        let health = self.health();
        vec![ProviderRouteStatus {
            provider_id: descriptor.id.clone(),
            display_name: descriptor.display_name,
            kind: descriptor.kind,
            healthy: health.healthy,
            circuit_state: health.circuit_state,
            detail: health.detail,
            latency_ms: health.latency_ms,
            is_primary: true,
            is_active: health.provider_id == self.active_provider_id(),
        }]
    }
}

pub trait SessionStore: Send + Sync {
    fn list_sessions(&self) -> Result<Vec<SessionSummary>, OctoError>;
    fn save_session(&self, session: SessionSummary) -> Result<(), OctoError>;
}

pub trait ConversationStore: SessionStore + Send + Sync {
    fn load_session(&self, id: &str) -> Result<ConversationSession, OctoError>;
    fn append_message(&self, session_id: &str, message: ConversationMessage) -> Result<(), OctoError>;
    fn replace_messages(
        &self,
        session_id: &str,
        messages: Vec<ConversationMessage>,
    ) -> Result<(), OctoError>;
    fn latest_session_id(&self) -> Result<Option<String>, OctoError>;
}

pub trait ToolExecutor: Send + Sync {
    fn execute(&self, call: ToolCall) -> Result<ToolResult, OctoError>;
}

pub trait ToolCatalog: Send + Sync {
    fn descriptors(&self) -> &[ToolDescriptor];

    fn descriptor(&self, name: &str) -> Option<&ToolDescriptor> {
        self.descriptors()
            .iter()
            .find(|descriptor| descriptor.name == name)
    }
}

pub trait PermissionPolicy: Send + Sync {
    fn ensure_allowed(
        &self,
        current: &PermissionMode,
        required: &PermissionMode,
        scope: &str,
    ) -> Result<(), OctoError>;
}

pub trait ProviderFactory: Send + Sync {
    type Provider: ModelProvider;

    fn descriptors(&self) -> &[ProviderDescriptor];
    fn create_from_config(&self, config: &RuntimeConfig) -> Self::Provider;
    fn create_by_id(&self, id: &str, config: &RuntimeConfig) -> Option<Self::Provider>;
}

pub trait PlatformSupport: Send + Sync {
    fn context(&self) -> &WorkspaceContext;
    fn config_paths(&self) -> ConfigPaths;
}

pub fn permission_rank(mode: &PermissionMode) -> u8 {
    match mode {
        PermissionMode::ReadOnly => 0,
        PermissionMode::WorkspaceWrite => 1,
        PermissionMode::DangerFullAccess => 2,
    }
}

pub fn permission_allows(current: &PermissionMode, required: &PermissionMode) -> bool {
    permission_rank(current) >= permission_rank(required)
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
