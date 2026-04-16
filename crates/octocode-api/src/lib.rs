use octocode_core::{ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderDescriptor};

pub struct StubProvider;

impl ModelProvider for StubProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: String::from("stub"),
            display_name: String::from("Stub Provider"),
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
