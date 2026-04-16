use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderDescriptor, ProviderKind,
};

pub struct StubProvider;

pub struct ProviderRegistry {
    providers: Vec<ProviderDescriptor>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: vec![
                ProviderDescriptor {
                    id: String::from("stub"),
                    display_name: String::from("Stub Provider"),
                    kind: ProviderKind::Stub,
                    supports_tools: false,
                    supports_streaming: false,
                },
                ProviderDescriptor {
                    id: String::from("anthropic"),
                    display_name: String::from("Anthropic"),
                    kind: ProviderKind::Anthropic,
                    supports_tools: true,
                    supports_streaming: true,
                },
                ProviderDescriptor {
                    id: String::from("openai-compatible"),
                    display_name: String::from("OpenAI Compatible"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: true,
                    supports_streaming: true,
                },
                ProviderDescriptor {
                    id: String::from("ollama"),
                    display_name: String::from("Ollama"),
                    kind: ProviderKind::Ollama,
                    supports_tools: false,
                    supports_streaming: true,
                },
            ],
        }
    }

    pub fn all(&self) -> &[ProviderDescriptor] {
        &self.providers
    }
}

impl ModelProvider for StubProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: String::from("stub"),
            display_name: String::from("Stub Provider"),
            kind: ProviderKind::Stub,
            supports_tools: false,
            supports_streaming: false,
        }
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        Ok(PromptResponse {
            output: format!("stub response: {}", request.text),
        })
    }
}
