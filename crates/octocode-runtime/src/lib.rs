use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, SessionStore, SessionSummary,
    ToolCall, ToolExecutor, ToolResult, WorkspaceContext,
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

pub struct OctocodeRuntime<P, S, T> {
    provider: P,
    sessions: S,
    tools: T,
    workspace: WorkspaceContext,
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
            workspace,
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
        &self.workspace
    }
}
