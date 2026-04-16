use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderDescriptor, ProviderKind,
};

#[derive(Clone)]
pub struct BuiltinProvider {
    descriptor: ProviderDescriptor,
    mode_label: String,
}

impl BuiltinProvider {
    fn new(descriptor: ProviderDescriptor, mode_label: &str) -> Self {
        Self {
            descriptor,
            mode_label: String::from(mode_label),
        }
    }
}

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
                    id: String::from("local-echo"),
                    display_name: String::from("Local Echo Model"),
                    kind: ProviderKind::LlamaCpp,
                    supports_tools: true,
                    supports_streaming: false,
                },
                ProviderDescriptor {
                    id: String::from("remote-echo"),
                    display_name: String::from("Remote Echo Gateway"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: true,
                    supports_streaming: true,
                },
                ProviderDescriptor {
                    id: String::from("ollama-bridge"),
                    display_name: String::from("Ollama Bridge"),
                    kind: ProviderKind::Ollama,
                    supports_tools: true,
                    supports_streaming: true,
                },
            ],
        }
    }

    pub fn all(&self) -> &[ProviderDescriptor] {
        &self.providers
    }

    pub fn default_provider_id() -> String {
        std::env::var("OCTOCODE_PROVIDER").unwrap_or_else(|_| String::from("local-echo"))
    }

    pub fn create_default(&self) -> BuiltinProvider {
        let id = Self::default_provider_id();
        self.create_by_id(&id)
            .unwrap_or_else(|| self.create_by_id("local-echo").expect("local-echo provider exists"))
    }

    pub fn create_by_id(&self, id: &str) -> Option<BuiltinProvider> {
        let descriptor = self.providers.iter().find(|provider| provider.id == id)?.clone();
        let provider = match descriptor.id.as_str() {
            "remote-echo" => BuiltinProvider::new(descriptor, "remote"),
            "ollama-bridge" => BuiltinProvider::new(descriptor, "ollama"),
            "stub" => BuiltinProvider::new(descriptor, "stub"),
            _ => BuiltinProvider::new(descriptor, "local"),
        };
        Some(provider)
    }
}

impl ModelProvider for BuiltinProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let model = request
            .model
            .or_else(|| std::env::var("OCTOCODE_MODEL").ok())
            .unwrap_or_else(|| String::from("octocode-default"));
        let token_hint = if std::env::var("OCTOCODE_API_TOKEN").is_ok() {
            "token-ready"
        } else {
            "token-missing"
        };
        Ok(PromptResponse {
            output: format!(
                "[{mode}:{provider}:{model}:{token}] {text}",
                mode = self.mode_label,
                provider = self.descriptor.id,
                model = model,
                token = token_hint,
                text = request.text
            ),
        })
    }
}
