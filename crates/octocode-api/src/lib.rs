use std::process::Command;
use std::time::Instant;

use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderDescriptor, ProviderHealth,
    ProviderKind, RuntimeConfig,
};

const DEFAULT_LOCAL_BASE_URL: &str = "http://192.168.110.2:8000/v1";
const DEFAULT_REMOTE_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_LOCAL_MODEL: &str = "gemma-4-31b-it-q8-prod";

#[derive(Clone)]
pub enum BuiltinProvider {
    Stub(StubProvider),
    OpenAiCompatible(OpenAiCompatibleProvider),
    Fallback(FallbackProvider),
}

#[derive(Clone)]
pub struct StubProvider {
    descriptor: ProviderDescriptor,
}

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    descriptor: ProviderDescriptor,
    base_url: String,
    api_token: Option<String>,
    default_model: Option<String>,
}

#[derive(Clone)]
pub struct FallbackProvider {
    descriptor: ProviderDescriptor,
    candidates: Vec<BuiltinProvider>,
}

impl StubProvider {
    fn new(descriptor: ProviderDescriptor) -> Self {
        Self { descriptor }
    }
}

impl OpenAiCompatibleProvider {
    fn new(
        descriptor: ProviderDescriptor,
        base_url: String,
        api_token: Option<String>,
        default_model: Option<String>,
    ) -> Self {
        Self {
            descriptor,
            base_url,
            api_token,
            default_model,
        }
    }

    fn resolve_model(&self, requested_model: Option<String>) -> Result<String, OctoError> {
        if let Some(model) = requested_model {
            return Ok(model);
        }
        if let Some(model) = &self.default_model {
            return Ok(model.clone());
        }

        let models_url = format!("{}/models", self.base_url.trim_end_matches('/'));
        let body = run_curl_request("GET", &models_url, None, self.api_token.as_deref())?;
        first_model_id(&body).ok_or_else(|| {
            OctoError::Provider(format!(
                "provider {} returned no usable model ids from {}",
                self.descriptor.id, models_url
            ))
        })
    }

    fn probe(&self) -> ProviderHealth {
        let started_at = Instant::now();
        let models_url = format!("{}/models", self.base_url.trim_end_matches('/'));
        match run_curl_request("GET", &models_url, None, self.api_token.as_deref()) {
            Ok(body) => ProviderHealth {
                provider_id: self.descriptor.id.clone(),
                display_name: self.descriptor.display_name.clone(),
                healthy: true,
                detail: format!("reachable {}", self.base_url),
                model: first_model_id(&body).or_else(|| self.default_model.clone()),
                latency_ms: Some(started_at.elapsed().as_millis()),
            },
            Err(error) => ProviderHealth {
                provider_id: self.descriptor.id.clone(),
                display_name: self.descriptor.display_name.clone(),
                healthy: false,
                detail: error.to_string(),
                model: self.default_model.clone(),
                latency_ms: Some(started_at.elapsed().as_millis()),
            },
        }
    }
}

impl FallbackProvider {
    fn new(descriptor: ProviderDescriptor, candidates: Vec<BuiltinProvider>) -> Self {
        Self {
            descriptor,
            candidates,
        }
    }

    fn pick_active(&self) -> Option<ProviderHealth> {
        self.health_catalog().into_iter().find(|health| health.healthy)
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
                    id: String::from("local-openai"),
                    display_name: String::from("Local OpenAI-Compatible Model"),
                    kind: ProviderKind::LlamaCpp,
                    supports_tools: false,
                    supports_streaming: false,
                },
                ProviderDescriptor {
                    id: String::from("remote-openai"),
                    display_name: String::from("Remote OpenAI-Compatible Gateway"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: false,
                    supports_streaming: true,
                },
            ],
        }
    }

    pub fn all(&self) -> &[ProviderDescriptor] {
        &self.providers
    }

    pub fn default_provider_id() -> String {
        std::env::var("OCTOCODE_PROVIDER").unwrap_or_else(|_| String::from("local-openai"))
    }

    pub fn create_default(&self) -> BuiltinProvider {
        let id = Self::default_provider_id();
        self.create_by_id(&id).unwrap_or_else(|| {
            self.create_by_id("local-openai")
                .expect("local-openai provider exists")
        })
    }

    pub fn create_from_config(&self, config: &RuntimeConfig) -> BuiltinProvider {
        let provider_id = config
            .provider_id
            .clone()
            .unwrap_or_else(Self::default_provider_id);
        self.create_by_id_with_config(&provider_id, config)
            .unwrap_or_else(|| self.create_default())
    }

    pub fn create_by_id(&self, id: &str) -> Option<BuiltinProvider> {
        self.create_by_id_with_config(
            id,
            &RuntimeConfig {
                provider_id: Some(String::from(id)),
                provider_base_url: None,
                default_model: None,
                permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
                history_limit: 24,
            },
        )
    }

    pub fn create_by_id_with_config(&self, id: &str, config: &RuntimeConfig) -> Option<BuiltinProvider> {
        let descriptor = self.providers.iter().find(|provider| provider.id == id)?.clone();
        let provider = match descriptor.id.as_str() {
            "stub" => BuiltinProvider::Stub(StubProvider::new(descriptor)),
            "remote-openai" => BuiltinProvider::Fallback(FallbackProvider::new(
                descriptor.clone(),
                vec![
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        descriptor,
                        config
                            .provider_base_url
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_REMOTE_BASE_URL").ok())
                            .unwrap_or_else(|| String::from(DEFAULT_REMOTE_BASE_URL)),
                        std::env::var("OCTOCODE_API_TOKEN").ok(),
                        config.default_model.clone(),
                    )),
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        self.providers
                            .iter()
                            .find(|provider| provider.id == "local-openai")?
                            .clone(),
                        std::env::var("OCTOCODE_PROVIDER_BASE_URL")
                            .ok()
                            .unwrap_or_else(|| String::from(DEFAULT_LOCAL_BASE_URL)),
                        std::env::var("OCTOCODE_LOCAL_API_TOKEN")
                            .ok()
                            .or_else(|| std::env::var("OCTOCODE_API_TOKEN").ok()),
                        config
                            .default_model
                            .clone()
                            .or_else(|| Some(String::from(DEFAULT_LOCAL_MODEL))),
                    )),
                    BuiltinProvider::Stub(StubProvider::new(
                        self.providers.iter().find(|provider| provider.id == "stub")?.clone(),
                    )),
                ],
            )),
            _ => BuiltinProvider::Fallback(FallbackProvider::new(
                descriptor.clone(),
                vec![
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        descriptor,
                        config
                            .provider_base_url
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_PROVIDER_BASE_URL").ok())
                            .unwrap_or_else(|| String::from(DEFAULT_LOCAL_BASE_URL)),
                        std::env::var("OCTOCODE_LOCAL_API_TOKEN")
                            .ok()
                            .or_else(|| std::env::var("OCTOCODE_API_TOKEN").ok()),
                        config
                            .default_model
                            .clone()
                            .or_else(|| Some(String::from(DEFAULT_LOCAL_MODEL))),
                    )),
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        self.providers
                            .iter()
                            .find(|provider| provider.id == "remote-openai")?
                            .clone(),
                        std::env::var("OCTOCODE_REMOTE_BASE_URL")
                            .ok()
                            .unwrap_or_else(|| String::from(DEFAULT_REMOTE_BASE_URL)),
                        std::env::var("OCTOCODE_API_TOKEN").ok(),
                        config.default_model.clone(),
                    )),
                    BuiltinProvider::Stub(StubProvider::new(
                        self.providers.iter().find(|provider| provider.id == "stub")?.clone(),
                    )),
                ],
            )),
        };
        Some(provider)
    }
}

impl ModelProvider for BuiltinProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        match self {
            Self::Stub(provider) => provider.descriptor(),
            Self::OpenAiCompatible(provider) => provider.descriptor(),
            Self::Fallback(provider) => provider.descriptor(),
        }
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        match self {
            Self::Stub(provider) => provider.prompt(request),
            Self::OpenAiCompatible(provider) => provider.prompt(request),
            Self::Fallback(provider) => provider.prompt(request),
        }
    }

    fn active_provider_id(&self) -> String {
        match self {
            Self::Stub(provider) => provider.active_provider_id(),
            Self::OpenAiCompatible(provider) => provider.active_provider_id(),
            Self::Fallback(provider) => provider.active_provider_id(),
        }
    }

    fn health(&self) -> ProviderHealth {
        match self {
            Self::Stub(provider) => provider.health(),
            Self::OpenAiCompatible(provider) => provider.health(),
            Self::Fallback(provider) => provider.health(),
        }
    }

    fn health_catalog(&self) -> Vec<ProviderHealth> {
        match self {
            Self::Stub(provider) => provider.health_catalog(),
            Self::OpenAiCompatible(provider) => provider.health_catalog(),
            Self::Fallback(provider) => provider.health_catalog(),
        }
    }
}

impl ModelProvider for StubProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        Ok(PromptResponse {
            output: format!("[stub:{}] {}", request.model.unwrap_or_default(), request.text),
        })
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            healthy: true,
            detail: String::from("stub fallback ready"),
            model: Some(String::from("stub")),
            latency_ms: Some(0),
        }
    }
}

impl ModelProvider for OpenAiCompatibleProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let model = self.resolve_model(request.model)?;
        let body = format!(
            concat!(
                "{{",
                "\"model\":\"{}\",",
                "\"messages\":[{{\"role\":\"user\",\"content\":\"{}\"}}],",
                "\"temperature\":0.2",
                "}}"
            ),
            escape_json(&model),
            escape_json(&request.text)
        );
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let response = run_curl_request("POST", &url, Some(&body), self.api_token.as_deref())?;
        let output = extract_message_content(&response).ok_or_else(|| {
            OctoError::Provider(format!(
                "provider {} returned an unsupported response shape: {}",
                self.descriptor.id, response
            ))
        })?;
        Ok(PromptResponse { output })
    }

    fn health(&self) -> ProviderHealth {
        self.probe()
    }
}

impl ModelProvider for FallbackProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let mut failures = Vec::new();

        for candidate in &self.candidates {
            let health = candidate.health();
            if !health.healthy {
                failures.push(format!("{} unhealthy: {}", health.provider_id, health.detail));
                continue;
            }

            let mut candidate_request = request.clone();
            if candidate_request.model.is_none() {
                candidate_request.model = health.model.clone();
            }

            match candidate.prompt(candidate_request) {
                Ok(response) => return Ok(response),
                Err(error) => failures.push(format!("{} failed: {}", health.provider_id, error)),
            }
        }

        Err(OctoError::Provider(format!(
            "all fallback providers failed for {}: {}",
            self.descriptor.id,
            failures.join(" | ")
        )))
    }

    fn active_provider_id(&self) -> String {
        self.pick_active()
            .map(|health| health.provider_id)
            .unwrap_or_else(|| self.descriptor.id.clone())
    }

    fn health(&self) -> ProviderHealth {
        self.pick_active().unwrap_or_else(|| ProviderHealth {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            healthy: false,
            detail: String::from("no healthy fallback provider available"),
            model: None,
            latency_ms: None,
        })
    }

    fn health_catalog(&self) -> Vec<ProviderHealth> {
        self.candidates.iter().map(ModelProvider::health).collect()
    }
}

fn run_curl_request(
    method: &str,
    url: &str,
    body: Option<&str>,
    token: Option<&str>,
) -> Result<String, OctoError> {
    if cfg!(target_os = "windows") {
        return run_powershell_request(method, url, body, token);
    }

    let mut command = Command::new("curl");
    command
        .arg("-sS")
        .arg("--retry")
        .arg("2")
        .arg("--retry-delay")
        .arg("1")
        .arg("--max-time")
        .arg("90");
    command.arg("-X").arg(method);
    command.arg(url);
    command.arg("-H").arg("Content-Type: application/json");
    if let Some(token) = token {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {token}"));
    }
    if let Some(body) = body {
        command.arg("-d").arg(body);
    }

    let output = command.output().map_err(|error| {
        OctoError::Provider(format!("failed to launch curl for {} {}: {error}", method, url))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(OctoError::Provider(format!(
            "curl request failed for {} {}: {}",
            method, url, stderr
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_powershell_request(
    method: &str,
    url: &str,
    body: Option<&str>,
    token: Option<&str>,
) -> Result<String, OctoError> {
    let body_literal = escape_powershell_single_quoted(body.unwrap_or(""));
    let token_literal = escape_powershell_single_quoted(token.unwrap_or(""));
    let script = format!(
        concat!(
            "$ProgressPreference='SilentlyContinue';",
            "$headers=@{{'Content-Type'='application/json'}};",
            "if ('{token}' -ne '') {{ $headers['Authorization']='Bearer {token}'; }};",
            "$body='{body}';",
            "$params=@{{Uri='{url}';Method='{method}';Headers=$headers;TimeoutSec=90;UseBasicParsing=$true}};",
            "if ('{body}' -ne '') {{ $params['Body']=$body }};",
            "$response=Invoke-WebRequest @params;",
            "$response.Content"
        ),
        token = token_literal,
        body = body_literal,
        url = escape_powershell_single_quoted(url),
        method = escape_powershell_single_quoted(method),
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|error| {
            OctoError::Provider(format!(
                "failed to launch powershell request for {} {}: {error}",
                method, url
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(OctoError::Provider(format!(
            "powershell request failed for {} {}: {}",
            method, url, stderr
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn first_model_id(body: &str) -> Option<String> {
    let data_index = body.find("\"data\"")?;
    let data_slice = &body[data_index..];
    extract_json_string_after(data_slice, "\"id\":\"")
}

fn extract_message_content(body: &str) -> Option<String> {
    let message_index = body.find("\"message\"")?;
    let message_slice = &body[message_index..];
    extract_json_string_after(message_slice, "\"content\":\"")
}

fn extract_json_string_after(body: &str, marker: &str) -> Option<String> {
    let start = body.find(marker)? + marker.len();
    let bytes = body.as_bytes();
    let mut index = start;
    let mut escaped = false;
    let mut output = String::new();

    while index < bytes.len() {
        let ch = bytes[index] as char;
        if escaped {
            output.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                other => other,
            });
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(output);
        } else {
            output.push(ch);
        }
        index += 1;
    }

    None
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}
