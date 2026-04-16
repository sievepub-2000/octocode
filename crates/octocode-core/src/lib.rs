#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformKind {
    Windows,
    MacOs,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub model: Option<String>,
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
    pub supports_tools: bool,
    pub supports_streaming: bool,
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
