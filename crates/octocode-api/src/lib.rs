use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderCircuitEvent,
    ProviderCircuitEventKind, ProviderCircuitState, ProviderCircuitStatus, ProviderDescriptor,
    ProviderHealth, ProviderKind, RuntimeConfig,
};

const DEFAULT_LOCAL_BASE_URL: &str = "http://192.168.110.2:8000/v1";
const DEFAULT_REMOTE_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_LOCAL_MODEL: &str = "gemma-4-31b-it-q8-prod";
const CIRCUIT_FAILURE_THRESHOLD: u32 = 2;
const CIRCUIT_COOLDOWN: Duration = Duration::from_secs(30);

static CIRCUIT_BREAKERS: OnceLock<Mutex<HashMap<String, CircuitState>>> = OnceLock::new();

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

#[derive(Clone, Debug)]
struct CircuitState {
    consecutive_failures: u32,
    open_until: Option<Instant>,
    last_failure_reason: Option<String>,
    last_opened_at_ms: Option<u128>,
    last_half_opened_at_ms: Option<u128>,
    last_recovered_at_ms: Option<u128>,
    event_log: Vec<ProviderCircuitEvent>,
}

#[derive(Clone, Debug)]
struct CircuitSnapshot {
    state: ProviderCircuitState,
    failure_count: u32,
    cooldown_remaining_ms: Option<u128>,
    recent_failure_reason: Option<String>,
    last_opened_at_ms: Option<u128>,
    last_half_opened_at_ms: Option<u128>,
    last_recovered_at_ms: Option<u128>,
    event_log: Vec<ProviderCircuitEvent>,
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
        let snapshot = self.snapshot_circuit();
        if snapshot.state == ProviderCircuitState::Open {
            return self.health_from_snapshot(
                false,
                snapshot
                    .recent_failure_reason
                    .clone()
                    .unwrap_or_else(|| String::from("provider cooling down")),
                self.default_model.clone(),
                None,
                snapshot,
            );
        }

        let started_at = Instant::now();
        let models_url = format!("{}/models", self.base_url.trim_end_matches('/'));
        match run_curl_request("GET", &models_url, None, self.api_token.as_deref()) {
            Ok(body) => {
                self.reset_circuit();
                self.health_from_snapshot(
                    true,
                    if snapshot.state == ProviderCircuitState::HalfOpen {
                        format!("recovered {}", self.base_url)
                    } else {
                        format!("reachable {}", self.base_url)
                    },
                    first_model_id(&body).or_else(|| self.default_model.clone()),
                    Some(started_at.elapsed().as_millis()),
                    self.snapshot_circuit(),
                )
            }
            Err(error) => {
                let recorded = self.record_failure(error.to_string());
                self.health_from_snapshot(
                    false,
                    self.circuit_detail(&recorded),
                    self.default_model.clone(),
                    Some(started_at.elapsed().as_millis()),
                    recorded,
                )
            }
        }
    }

    fn cache_key(&self) -> String {
        format!("{}|{}", self.descriptor.id, self.base_url)
    }

    fn snapshot_circuit(&self) -> CircuitSnapshot {
        let now = Instant::now();
        let guard = circuit_book().lock().expect("circuit book lock poisoned");
        let state = guard.get(&self.cache_key());
        match state {
            Some(state) => {
                let mut half_open_at_ms = state.last_half_opened_at_ms;
                let (circuit_state, cooldown_remaining_ms) = match state.open_until {
                    Some(deadline) if deadline > now => {
                        (ProviderCircuitState::Open, Some(deadline.duration_since(now).as_millis()))
                    }
                    Some(_) => {
                        if half_open_at_ms.is_none() {
                            half_open_at_ms = Some(now_ms());
                        }
                        (ProviderCircuitState::HalfOpen, Some(0))
                    }
                    None => (ProviderCircuitState::Closed, None),
                };
                CircuitSnapshot {
                    state: circuit_state,
                    failure_count: state.consecutive_failures,
                    cooldown_remaining_ms,
                    recent_failure_reason: state.last_failure_reason.clone(),
                    last_opened_at_ms: state.last_opened_at_ms,
                    last_half_opened_at_ms: half_open_at_ms,
                    last_recovered_at_ms: state.last_recovered_at_ms,
                    event_log: state.event_log.clone(),
                }
            }
            None => CircuitSnapshot {
                state: ProviderCircuitState::Closed,
                failure_count: 0,
                cooldown_remaining_ms: None,
                recent_failure_reason: None,
                last_opened_at_ms: None,
                last_half_opened_at_ms: None,
                last_recovered_at_ms: None,
                event_log: Vec::new(),
            },
        }
    }

    fn reset_circuit(&self) {
        let mut guard = circuit_book().lock().expect("circuit book lock poisoned");
        if let Some(state) = guard.get_mut(&self.cache_key()) {
            if state.consecutive_failures > 0 || state.open_until.is_some() {
                state.last_recovered_at_ms = Some(now_ms());
                push_event(
                    &mut state.event_log,
                    ProviderCircuitEventKind::Recovered,
                    format!("provider {} recovered", self.descriptor.id),
                );
            }
            state.consecutive_failures = 0;
            state.open_until = None;
            state.last_failure_reason = None;
            state.last_half_opened_at_ms = None;
        }
    }

    fn record_failure(&self, detail: String) -> CircuitSnapshot {
        let now = Instant::now();
        let now_ms = now_ms();
        let mut guard = circuit_book().lock().expect("circuit book lock poisoned");
        let state = guard.entry(self.cache_key()).or_insert(CircuitState {
            consecutive_failures: 0,
            open_until: None,
            last_failure_reason: None,
            last_opened_at_ms: None,
            last_half_opened_at_ms: None,
            last_recovered_at_ms: None,
            event_log: Vec::new(),
        });

        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        state.last_failure_reason = Some(detail.clone());
        push_event(
            &mut state.event_log,
            ProviderCircuitEventKind::Failure,
            detail.clone(),
        );
        if state.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD {
            state.open_until = Some(now + CIRCUIT_COOLDOWN);
            state.last_opened_at_ms = Some(now_ms);
            push_event(
                &mut state.event_log,
                ProviderCircuitEventKind::Opened,
                format!(
                    "circuit opened after {} failures; cooling down for {}ms",
                    state.consecutive_failures,
                    CIRCUIT_COOLDOWN.as_millis()
                ),
            );
        } else {
            state.open_until = None;
        }

        let (circuit_state, cooldown_remaining_ms, last_half_opened_at_ms) = match state.open_until {
            Some(deadline) if deadline > now => {
                (ProviderCircuitState::Open, Some(deadline.duration_since(now).as_millis()), state.last_half_opened_at_ms)
            }
            Some(_) => {
                state.last_half_opened_at_ms = Some(now_ms);
                push_event(
                    &mut state.event_log,
                    ProviderCircuitEventKind::HalfOpen,
                    format!("circuit half-open for {}", self.descriptor.id),
                );
                (ProviderCircuitState::HalfOpen, Some(0), state.last_half_opened_at_ms)
            }
            None => (ProviderCircuitState::Closed, None, state.last_half_opened_at_ms),
        };
        CircuitSnapshot {
            state: circuit_state,
            failure_count: state.consecutive_failures,
            cooldown_remaining_ms,
            recent_failure_reason: Some(detail),
            last_opened_at_ms: state.last_opened_at_ms,
            last_half_opened_at_ms,
            last_recovered_at_ms: state.last_recovered_at_ms,
            event_log: state.event_log.clone(),
        }
    }

    fn health_from_snapshot(
        &self,
        healthy: bool,
        detail: String,
        model: Option<String>,
        latency_ms: Option<u128>,
        snapshot: CircuitSnapshot,
    ) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            healthy,
            detail,
            model,
            latency_ms,
            circuit_state: snapshot.state,
            failure_count: snapshot.failure_count,
            cooldown_remaining_ms: snapshot.cooldown_remaining_ms,
        }
    }

    fn circuit_status_from_snapshot(&self, snapshot: CircuitSnapshot) -> ProviderCircuitStatus {
        ProviderCircuitStatus {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            circuit_state: snapshot.state,
            failure_count: snapshot.failure_count,
            cooldown_remaining_ms: snapshot.cooldown_remaining_ms,
            recent_failure_reason: snapshot.recent_failure_reason,
            last_opened_at_ms: snapshot.last_opened_at_ms,
            last_half_opened_at_ms: snapshot.last_half_opened_at_ms,
            last_recovered_at_ms: snapshot.last_recovered_at_ms,
            event_log: snapshot.event_log,
        }
    }

    fn circuit_detail(&self, snapshot: &CircuitSnapshot) -> String {
        match snapshot.state {
            ProviderCircuitState::Open => format!(
                "circuit open after {} failures; retry in {}ms; last failure: {}",
                snapshot.failure_count,
                snapshot.cooldown_remaining_ms.unwrap_or(0),
                snapshot
                    .recent_failure_reason
                    .clone()
                    .unwrap_or_else(|| String::from("unknown"))
            ),
            ProviderCircuitState::HalfOpen => format!(
                "circuit half-open; probing recovery after {} failures; last failure: {}",
                snapshot.failure_count,
                snapshot
                    .recent_failure_reason
                    .clone()
                    .unwrap_or_else(|| String::from("unknown"))
            ),
            ProviderCircuitState::Closed => snapshot
                .recent_failure_reason
                .clone()
                .unwrap_or_else(|| format!("reachable {}", self.base_url)),
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

    fn circuit_status(&self) -> ProviderCircuitStatus {
        match self {
            Self::Stub(provider) => provider.circuit_status(),
            Self::OpenAiCompatible(provider) => provider.circuit_status(),
            Self::Fallback(provider) => provider.circuit_status(),
        }
    }

    fn circuit_catalog(&self) -> Vec<ProviderCircuitStatus> {
        match self {
            Self::Stub(provider) => provider.circuit_catalog(),
            Self::OpenAiCompatible(provider) => provider.circuit_catalog(),
            Self::Fallback(provider) => provider.circuit_catalog(),
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
            circuit_state: ProviderCircuitState::Closed,
            failure_count: 0,
            cooldown_remaining_ms: None,
        }
    }

    fn circuit_status(&self) -> ProviderCircuitStatus {
        ProviderCircuitStatus {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            circuit_state: ProviderCircuitState::Closed,
            failure_count: 0,
            cooldown_remaining_ms: None,
            recent_failure_reason: None,
            last_opened_at_ms: None,
            last_half_opened_at_ms: None,
            last_recovered_at_ms: None,
            event_log: vec![ProviderCircuitEvent {
                at_ms: now_ms(),
                kind: ProviderCircuitEventKind::Recovered,
                detail: String::from("stub fallback ready"),
            }],
        }
    }
}

impl ModelProvider for OpenAiCompatibleProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let snapshot = self.snapshot_circuit();
        if snapshot.state == ProviderCircuitState::Open {
            return Err(OctoError::Provider(self.circuit_detail(&snapshot)));
        }

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
        let response = run_curl_request("POST", &url, Some(&body), self.api_token.as_deref())
            .map_err(|error| {
                let snapshot = self.record_failure(error.to_string());
                OctoError::Provider(self.circuit_detail(&snapshot))
            })?;
        let output = extract_message_content(&response).ok_or_else(|| {
            OctoError::Provider(format!(
                "provider {} returned an unsupported response shape: {}",
                self.descriptor.id, response
            ))
        })?;
        self.reset_circuit();
        Ok(PromptResponse { output })
    }

    fn health(&self) -> ProviderHealth {
        self.probe()
    }

    fn circuit_status(&self) -> ProviderCircuitStatus {
        self.circuit_status_from_snapshot(self.snapshot_circuit())
    }
}

impl ModelProvider for FallbackProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let mut failures = Vec::new();

        for candidate in &self.candidates {
            match candidate.prompt(request.clone()) {
                Ok(response) => return Ok(response),
                Err(error) => failures.push(format!("{} failed: {}", candidate.active_provider_id(), error)),
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
            circuit_state: ProviderCircuitState::Open,
            failure_count: 0,
            cooldown_remaining_ms: None,
        })
    }

    fn health_catalog(&self) -> Vec<ProviderHealth> {
        self.candidates.iter().map(ModelProvider::health).collect()
    }

    fn circuit_status(&self) -> ProviderCircuitStatus {
        self.pick_active()
            .and_then(|health| {
                self.circuit_catalog()
                    .into_iter()
                    .find(|status| status.provider_id == health.provider_id)
            })
            .unwrap_or_else(|| ProviderCircuitStatus {
                provider_id: self.descriptor.id.clone(),
                display_name: self.descriptor.display_name.clone(),
                circuit_state: ProviderCircuitState::Open,
                failure_count: 0,
                cooldown_remaining_ms: None,
                recent_failure_reason: Some(String::from("no healthy fallback provider available")),
                last_opened_at_ms: None,
                last_half_opened_at_ms: None,
                last_recovered_at_ms: None,
                event_log: Vec::new(),
            })
    }

    fn circuit_catalog(&self) -> Vec<ProviderCircuitStatus> {
        self.candidates.iter().map(ModelProvider::circuit_status).collect()
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

fn circuit_book() -> &'static Mutex<HashMap<String, CircuitState>> {
    CIRCUIT_BREAKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn push_event(log: &mut Vec<ProviderCircuitEvent>, kind: ProviderCircuitEventKind, detail: String) {
    log.push(ProviderCircuitEvent {
        at_ms: now_ms(),
        kind,
        detail,
    });
    if log.len() > 24 {
        let drain_count = log.len() - 24;
        log.drain(0..drain_count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> OpenAiCompatibleProvider {
        OpenAiCompatibleProvider::new(
            ProviderDescriptor {
                id: String::from("local-openai"),
                display_name: String::from("Local OpenAI-Compatible Model"),
                kind: ProviderKind::LlamaCpp,
                supports_tools: false,
                supports_streaming: false,
            },
            String::from(DEFAULT_LOCAL_BASE_URL),
            None,
            Some(String::from(DEFAULT_LOCAL_MODEL)),
        )
    }

    fn clear_circuit(provider: &OpenAiCompatibleProvider) {
        let mut guard = circuit_book().lock().expect("circuit book lock poisoned");
        guard.remove(&provider.cache_key());
    }

    #[test]
    fn circuit_opens_after_threshold_failures() {
        let provider = provider();
        clear_circuit(&provider);

        let first = provider.record_failure(String::from("timeout-1"));
        assert_eq!(first.state, ProviderCircuitState::Closed);
        assert_eq!(first.failure_count, 1);
        assert_eq!(first.cooldown_remaining_ms, None);

        let second = provider.record_failure(String::from("timeout-2"));
        assert_eq!(second.state, ProviderCircuitState::Open);
        assert_eq!(second.failure_count, CIRCUIT_FAILURE_THRESHOLD);
        assert!(second.cooldown_remaining_ms.unwrap_or(0) > 0);

        clear_circuit(&provider);
    }

    #[test]
    fn circuit_moves_to_half_open_after_cooldown() {
        let provider = provider();
        clear_circuit(&provider);

        {
            let mut guard = circuit_book().lock().expect("circuit book lock poisoned");
            guard.insert(
                provider.cache_key(),
                CircuitState {
                    consecutive_failures: CIRCUIT_FAILURE_THRESHOLD,
                    open_until: Some(Instant::now() - Duration::from_millis(1)),
                    last_failure_reason: Some(String::from("expired cooldown")),
                    last_opened_at_ms: Some(now_ms()),
                    last_half_opened_at_ms: None,
                    last_recovered_at_ms: None,
                    event_log: Vec::new(),
                },
            );
        }

        let snapshot = provider.snapshot_circuit();
        assert_eq!(snapshot.state, ProviderCircuitState::HalfOpen);
        assert_eq!(snapshot.failure_count, CIRCUIT_FAILURE_THRESHOLD);

        clear_circuit(&provider);
    }
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
