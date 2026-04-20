// ─── Task types ────────────────────────────────────────────────────────────────

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Workflow,
    Agent,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub kind: TaskKind,
    pub session_id: String,
    pub label: String,
    pub state: TaskState,
    pub created_at_ms: u128,
    pub finished_at_ms: Option<u128>,
    pub result_summary: Option<String>,
}

// ─── Platform / Provider ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformKind {
    Windows,
    MacOs,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Stub,
    Anthropic,
    OpenAiCompatible,
    XAi,
    DashScope,
    Ollama,
    LlamaCpp,
    LinkMind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    PowerShell,
    Cmd,
    Zsh,
    Bash,
    Sh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub root: String,
    pub platform: PlatformKind,
    pub preferred_shell: ShellKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

impl TokenInfo {
    pub fn total(&self) -> u32 {
        self.input_tokens + self.output_tokens
    }

    pub fn new(input_tokens: u32, output_tokens: u32) -> Self {
        Self {
            input_tokens,
            output_tokens,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub model: Option<String>,
    pub parent_id: Option<String>,
    pub branch_name: Option<String>,
    pub total_input_tokens: u32,
    pub total_output_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: ConversationRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSession {
    pub summary: SessionSummary,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub text: String,
    pub model: Option<String>,
    /// Optional system prompt prepended to the conversation.
    pub system_prompt: Option<String>,
    /// Prior conversation turns (role, content) sent before the current text.
    pub history: Vec<(ConversationRole, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    pub output: String,
    pub tokens: Option<TokenInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: String,
    pub display_name: String,
    pub kind: ProviderKind,
    pub supports_tools: bool,
    pub supports_streaming: bool,
    pub capabilities: ProviderCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCircuitState {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCircuitEventKind {
    Failure,
    Opened,
    HalfOpen,
    Recovered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCircuitEvent {
    pub at_ms: u128,
    pub kind: ProviderCircuitEventKind,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransportKind {
    Stdio,
    WebSocket,
    Http,
    Sse,
    Sdk,
    ManagedProxy,
}

impl McpTransportKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::WebSocket => "websocket",
            Self::Http => "http",
            Self::Sse => "sse",
            Self::Sdk => "sdk",
            Self::ManagedProxy => "managed-proxy",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "websocket" | "ws" => Self::WebSocket,
            "http" | "https" => Self::Http,
            "sse" | "server-sent-events" => Self::Sse,
            "sdk" => Self::Sdk,
            "managed-proxy" | "managed_proxy" | "managed" => Self::ManagedProxy,
            _ => Self::Stdio,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpServerState {
    Disabled,
    Discovered,
    TrustRequired,
    ReadyForPrompt,
    Spawning,
    Running,
    Failed,
}

impl McpServerState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Discovered => "discovered",
            Self::TrustRequired => "trust-required",
            Self::ReadyForPrompt => "ready-for-prompt",
            Self::Spawning => "spawning",
            Self::Running => "running",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDescriptor {
    pub id: String,
    pub transport: McpTransportKind,
    pub command: Option<String>,
    pub endpoint: Option<String>,
    pub description: Option<String>,
    pub manifest_path: String,
    pub trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub descriptor: McpServerDescriptor,
    pub state: McpServerState,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillScope {
    Workspace,
    User,
}

impl SkillScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::User => "user",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub id: String,
    pub summary: String,
    pub path: String,
    pub scope: SkillScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPaths {
    pub config_home: String,
    pub cache_home: String,
    pub data_home: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub provider_id: Option<String>,
    pub provider_base_url: Option<String>,
    pub default_model: Option<String>,
    pub permission_mode: PermissionMode,
    pub history_limit: usize,
    pub denied_tools: Vec<String>,
    pub request_timeout_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputMode {
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub workspace: WorkspaceContext,
    pub paths: ConfigPaths,
    pub config: RuntimeConfig,
    pub provider_healths: Vec<ProviderHealth>,
    pub provider_circuits: Vec<ProviderCircuitStatus>,
    pub provider_routes: Vec<ProviderRouteStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
    pub name: &'static str,
    pub summary: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub summary: &'static str,
    pub minimum_permission: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub name: String,
    pub input: String,
    pub permission: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub scope: String,
    pub message: String,
    pub at_ms: Option<u128>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OctoError {
    Provider(String),
    Session(String),
    Runtime(String),
    Tool(String),
    Permission(String),
    Config(String),
}

pub trait ModelProvider: Send + Sync {
    fn descriptor(&self) -> ProviderDescriptor;
    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError>;

    /// Stream a prompt response token-by-token via callback.
    /// Each call to `on_token` receives a text delta.
    /// Default implementation falls back to non-streaming prompt.
    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<PromptResponse, OctoError> {
        let response = self.prompt(request)?;
        on_token(&response.output);
        Ok(response)
    }

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
            Self::Tool(message) => write!(formatter, "tool error: {message}"),
            Self::Permission(message) => write!(formatter, "permission denied: {message}"),
            Self::Config(message) => write!(formatter, "config error: {message}"),
        }
    }
}

impl std::error::Error for OctoError {}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── ConversationRole ──────────────────────────────────────────────

    #[test]
    fn conversation_role_as_str() {
        assert_eq!(ConversationRole::System.as_str(), "system");
        assert_eq!(ConversationRole::User.as_str(), "user");
        assert_eq!(ConversationRole::Assistant.as_str(), "assistant");
        assert_eq!(ConversationRole::Tool.as_str(), "tool");
    }

    #[test]
    fn conversation_role_parse_known() {
        assert_eq!(ConversationRole::parse("system"), ConversationRole::System);
        assert_eq!(ConversationRole::parse("assistant"), ConversationRole::Assistant);
        assert_eq!(ConversationRole::parse("tool"), ConversationRole::Tool);
    }

    #[test]
    fn conversation_role_parse_defaults_to_user() {
        assert_eq!(ConversationRole::parse("user"), ConversationRole::User);
        assert_eq!(ConversationRole::parse("unknown"), ConversationRole::User);
        assert_eq!(ConversationRole::parse(""), ConversationRole::User);
    }

    // ─── TokenInfo ─────────────────────────────────────────────────────

    #[test]
    fn token_info_total() {
        let ti = TokenInfo::new(100, 200);
        assert_eq!(ti.total(), 300);
    }

    #[test]
    fn token_info_zero() {
        let ti = TokenInfo::new(0, 0);
        assert_eq!(ti.total(), 0);
    }

    // ─── ProviderCapabilities ──────────────────────────────────────────

    #[test]
    fn provider_capabilities_stub() {
        let cap = ProviderCapabilities::stub();
        assert!(cap.chat);
        assert!(!cap.streaming);
        assert!(!cap.tool_calls);
        assert!(!cap.session_memory);
        assert!(!cap.json_output);
    }

    #[test]
    fn provider_capabilities_compatible() {
        let cap = ProviderCapabilities::compatible(true, true);
        assert!(cap.chat);
        assert!(cap.streaming);
        assert!(cap.tool_calls);
        assert!(cap.json_output);
        assert!(!cap.session_memory);
    }

    // ─── McpTransportKind ──────────────────────────────────────────────

    #[test]
    fn mcp_transport_as_str() {
        assert_eq!(McpTransportKind::Stdio.as_str(), "stdio");
        assert_eq!(McpTransportKind::WebSocket.as_str(), "websocket");
        assert_eq!(McpTransportKind::Http.as_str(), "http");
        assert_eq!(McpTransportKind::Sse.as_str(), "sse");
        assert_eq!(McpTransportKind::Sdk.as_str(), "sdk");
        assert_eq!(McpTransportKind::ManagedProxy.as_str(), "managed-proxy");
    }

    #[test]
    fn mcp_transport_parse() {
        assert_eq!(McpTransportKind::parse("websocket"), McpTransportKind::WebSocket);
        assert_eq!(McpTransportKind::parse("ws"), McpTransportKind::WebSocket);
        assert_eq!(McpTransportKind::parse("http"), McpTransportKind::Http);
        assert_eq!(McpTransportKind::parse("https"), McpTransportKind::Http);
        assert_eq!(McpTransportKind::parse("sse"), McpTransportKind::Sse);
        assert_eq!(McpTransportKind::parse("server-sent-events"), McpTransportKind::Sse);
        assert_eq!(McpTransportKind::parse("sdk"), McpTransportKind::Sdk);
        assert_eq!(McpTransportKind::parse("managed-proxy"), McpTransportKind::ManagedProxy);
        assert_eq!(McpTransportKind::parse("managed_proxy"), McpTransportKind::ManagedProxy);
        assert_eq!(McpTransportKind::parse("managed"), McpTransportKind::ManagedProxy);
        assert_eq!(McpTransportKind::parse("anything_else"), McpTransportKind::Stdio);
    }

    // ─── McpServerState ────────────────────────────────────────────────

    #[test]
    fn mcp_server_state_as_str() {
        assert_eq!(McpServerState::Disabled.as_str(), "disabled");
        assert_eq!(McpServerState::Running.as_str(), "running");
        assert_eq!(McpServerState::Failed.as_str(), "failed");
        assert_eq!(McpServerState::Discovered.as_str(), "discovered");
        assert_eq!(McpServerState::TrustRequired.as_str(), "trust-required");
        assert_eq!(McpServerState::ReadyForPrompt.as_str(), "ready-for-prompt");
        assert_eq!(McpServerState::Spawning.as_str(), "spawning");
    }

    // ─── SkillScope ────────────────────────────────────────────────────

    #[test]
    fn skill_scope_as_str() {
        assert_eq!(SkillScope::Workspace.as_str(), "workspace");
        assert_eq!(SkillScope::User.as_str(), "user");
    }

    // ─── Permission ────────────────────────────────────────────────────

    #[test]
    fn permission_rank_ordering() {
        assert!(permission_rank(&PermissionMode::ReadOnly) < permission_rank(&PermissionMode::WorkspaceWrite));
        assert!(permission_rank(&PermissionMode::WorkspaceWrite) < permission_rank(&PermissionMode::DangerFullAccess));
    }

    #[test]
    fn permission_allows_rules() {
        assert!(permission_allows(&PermissionMode::DangerFullAccess, &PermissionMode::ReadOnly));
        assert!(permission_allows(&PermissionMode::WorkspaceWrite, &PermissionMode::ReadOnly));
        assert!(permission_allows(&PermissionMode::ReadOnly, &PermissionMode::ReadOnly));
        assert!(!permission_allows(&PermissionMode::ReadOnly, &PermissionMode::WorkspaceWrite));
    }

    // ─── OctoError Display ─────────────────────────────────────────────

    #[test]
    fn octo_error_display() {
        assert_eq!(
            format!("{}", OctoError::Provider("timeout".into())),
            "provider error: timeout"
        );
        assert_eq!(
            format!("{}", OctoError::Session("not found".into())),
            "session error: not found"
        );
        assert_eq!(
            format!("{}", OctoError::Runtime("fatal".into())),
            "runtime error: fatal"
        );
    }

    // ─── TaskState & TaskKind ──────────────────────────────────────────

    #[test]
    fn task_enums_debug() {
        // Verify Debug + Clone + PartialEq derive work.
        let t = TaskRecord {
            id: "1".into(),
            kind: TaskKind::Workflow,
            session_id: "s1".into(),
            label: "test".into(),
            state: TaskState::Pending,
            created_at_ms: 0,
            finished_at_ms: None,
            result_summary: None,
        };
        let t2 = t.clone();
        assert_eq!(t, t2);
        assert_eq!(format!("{:?}", t.kind), "Workflow");
    }
}
