use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderCircuitEvent,
    ProviderCircuitEventKind, ProviderCircuitState, ProviderCircuitStatus, ProviderDescriptor,
    ProviderCapabilities, ProviderFactory, ProviderHealth, ProviderKind, RuntimeConfig,
};

const DEFAULT_LOCAL_BASE_URL: &str = "http://192.168.110.2:8000/v1";
const DEFAULT_REMOTE_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const DEFAULT_LINKMIND_BASE_URL: &str = "http://127.0.0.1:8080/v1";
const DEFAULT_LOCAL_MODEL: &str = "gemma-4-31b-it-q8-prod";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5-coder:14b";
const CIRCUIT_FAILURE_THRESHOLD: u32 = 2;
const CIRCUIT_BASE_COOLDOWN_SECS: u64 = 5;
const CIRCUIT_MAX_COOLDOWN_SECS: u64 = 120;
const HEALTH_CACHE_TTL: Duration = Duration::from_secs(5);

static CIRCUIT_BREAKERS: OnceLock<Mutex<HashMap<String, CircuitState>>> = OnceLock::new();
static HEALTH_CACHE: OnceLock<Mutex<HashMap<String, HealthCacheEntry>>> = OnceLock::new();

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

#[derive(Clone, Debug)]
struct HealthCacheEntry {
    captured_at: Instant,
    health: ProviderHealth,
}

impl StubProvider {
    fn new(descriptor: ProviderDescriptor) -> Self {
        Self { descriptor }
    }
}

fn health_cache_book() -> &'static Mutex<HashMap<String, HealthCacheEntry>> {
    HEALTH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remove expired entries from the health cache to prevent unbounded growth.
fn evict_stale_health_cache() {
    if let Ok(mut cache) = health_cache_book().lock() {
        cache.retain(|_, entry| entry.captured_at.elapsed() < HEALTH_CACHE_TTL);
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
        evict_stale_health_cache();
        if let Some(cached) = health_cache_book()
            .lock()
            .expect("health cache lock poisoned")
            .get(&self.cache_key())
            .cloned()
        {
            if cached.captured_at.elapsed() < HEALTH_CACHE_TTL {
                return cached.health;
            }
        }

        let snapshot = self.snapshot_circuit();
        if snapshot.state == ProviderCircuitState::Open {
            let health = self.health_from_snapshot(
                false,
                snapshot
                    .recent_failure_reason
                    .clone()
                    .unwrap_or_else(|| String::from("provider cooling down")),
                self.default_model.clone(),
                None,
                snapshot,
            );
            health_cache_book()
                .lock()
                .expect("health cache lock poisoned")
                .insert(
                    self.cache_key(),
                    HealthCacheEntry {
                        captured_at: Instant::now(),
                        health: health.clone(),
                    },
                );
            return health;
        }

        let started_at = Instant::now();
        let models_url = format!("{}/models", self.base_url.trim_end_matches('/'));
        // Use a short timeout for health probes so the WebUI /api/health
        // endpoint responds quickly even when providers are unreachable.
        match run_health_probe(&models_url, self.api_token.as_deref()) {
            Ok(body) => {
                self.reset_circuit();
                let health = self.health_from_snapshot(
                    true,
                    if snapshot.state == ProviderCircuitState::HalfOpen {
                        format!("recovered {}", self.base_url)
                    } else {
                        format!("reachable {}", self.base_url)
                    },
                    first_model_id(&body).or_else(|| self.default_model.clone()),
                    Some(started_at.elapsed().as_millis()),
                    self.snapshot_circuit(),
                );
                health_cache_book()
                    .lock()
                    .expect("health cache lock poisoned")
                    .insert(
                        self.cache_key(),
                        HealthCacheEntry {
                            captured_at: Instant::now(),
                            health: health.clone(),
                        },
                    );
                health
            }
            Err(error) => {
                let recorded = self.record_failure(error.to_string());
                let health = self.health_from_snapshot(
                    false,
                    self.circuit_detail(&recorded),
                    self.default_model.clone(),
                    Some(started_at.elapsed().as_millis()),
                    recorded,
                );
                health_cache_book()
                    .lock()
                    .expect("health cache lock poisoned")
                    .insert(
                        self.cache_key(),
                        HealthCacheEntry {
                            captured_at: Instant::now(),
                            health: health.clone(),
                        },
                    );
                health
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
        health_cache_book()
            .lock()
            .expect("health cache lock poisoned")
            .remove(&self.cache_key());
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
            // Exponential backoff: 5s, 10s, 20s, 40s, 80s, 120s (capped)
            let exponent = (state.consecutive_failures - CIRCUIT_FAILURE_THRESHOLD).min(6);
            let cooldown_secs = (CIRCUIT_BASE_COOLDOWN_SECS * (1 << exponent)).min(CIRCUIT_MAX_COOLDOWN_SECS);
            let cooldown = Duration::from_secs(cooldown_secs);
            state.open_until = Some(now + cooldown);
            state.last_opened_at_ms = Some(now_ms);
            push_event(
                &mut state.event_log,
                ProviderCircuitEventKind::Opened,
                format!(
                    "circuit opened after {} failures; cooling down for {}ms",
                    state.consecutive_failures,
                    cooldown.as_millis()
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

        health_cache_book()
            .lock()
            .expect("health cache lock poisoned")
            .remove(&self.cache_key());
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

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
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
                    capabilities: ProviderCapabilities::stub(),
                },
                ProviderDescriptor {
                    id: String::from("local-openai"),
                    display_name: String::from("Local OpenAI-Compatible Model"),
                    kind: ProviderKind::LlamaCpp,
                    supports_tools: false,
                    supports_streaming: false,
                    capabilities: ProviderCapabilities::compatible(false, false),
                },
                ProviderDescriptor {
                    id: String::from("remote-openai"),
                    display_name: String::from("Remote OpenAI-Compatible Gateway"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: false,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, false),
                },
                ProviderDescriptor {
                    id: String::from("ollama"),
                    display_name: String::from("Ollama Local Runtime"),
                    kind: ProviderKind::Ollama,
                    supports_tools: false,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, false),
                },
                ProviderDescriptor {
                    id: String::from("linkmind"),
                    display_name: String::from("LinkMind Agent Mate"),
                    kind: ProviderKind::LinkMind,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
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
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
            },
        )
    }

    pub fn create_by_id_with_config(&self, id: &str, config: &RuntimeConfig) -> Option<BuiltinProvider> {
        let descriptor = self.providers.iter().find(|provider| provider.id == id)?.clone();
        let provider = match descriptor.id.as_str() {
            "stub" => BuiltinProvider::Stub(StubProvider::new(descriptor)),
            "ollama" => BuiltinProvider::Fallback(FallbackProvider::new(
                descriptor.clone(),
                vec![
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        descriptor,
                        config
                            .provider_base_url
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_OLLAMA_BASE_URL").ok())
                            .unwrap_or_else(|| String::from(DEFAULT_OLLAMA_BASE_URL)),
                        std::env::var("OCTOCODE_OLLAMA_API_TOKEN")
                            .ok()
                            .or_else(|| std::env::var("OCTOCODE_LOCAL_API_TOKEN").ok())
                            .or_else(|| std::env::var("OCTOCODE_API_TOKEN").ok()),
                        config
                            .default_model
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_OLLAMA_MODEL").ok())
                            .or_else(|| Some(String::from(DEFAULT_OLLAMA_MODEL))),
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
            "linkmind" => BuiltinProvider::Fallback(FallbackProvider::new(
                descriptor.clone(),
                vec![
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        descriptor,
                        config
                            .provider_base_url
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_LINKMIND_BASE_URL").ok())
                            .unwrap_or_else(|| String::from(DEFAULT_LINKMIND_BASE_URL)),
                        std::env::var("OCTOCODE_LINKMIND_API_KEY")
                            .ok()
                            .or_else(|| std::env::var("OCTOCODE_API_TOKEN").ok()),
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
                            .find(|provider| provider.id == "ollama")?
                            .clone(),
                        std::env::var("OCTOCODE_OLLAMA_BASE_URL")
                            .ok()
                            .unwrap_or_else(|| String::from(DEFAULT_OLLAMA_BASE_URL)),
                        std::env::var("OCTOCODE_OLLAMA_API_TOKEN")
                            .ok()
                            .or_else(|| std::env::var("OCTOCODE_LOCAL_API_TOKEN").ok())
                            .or_else(|| std::env::var("OCTOCODE_API_TOKEN").ok()),
                        config
                            .default_model
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_OLLAMA_MODEL").ok())
                            .or_else(|| Some(String::from(DEFAULT_OLLAMA_MODEL))),
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

impl ProviderFactory for ProviderRegistry {
    type Provider = BuiltinProvider;

    fn descriptors(&self) -> &[ProviderDescriptor] {
        self.all()
    }

    fn create_from_config(&self, config: &RuntimeConfig) -> Self::Provider {
        ProviderRegistry::create_from_config(self, config)
    }

    fn create_by_id(&self, id: &str, config: &RuntimeConfig) -> Option<Self::Provider> {
        self.create_by_id_with_config(id, config)
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

    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<PromptResponse, OctoError> {
        match self {
            Self::Stub(provider) => provider.prompt_stream(request, on_token),
            Self::OpenAiCompatible(provider) => provider.prompt_stream(request, on_token),
            Self::Fallback(provider) => provider.prompt_stream(request, on_token),
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
            tokens: None,
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

        let messages_json = build_messages_json(&request);
        let model = self.resolve_model(request.model)?;
        let body = format!(
            "{{\"model\":\"{}\",\"messages\":[{}],\"temperature\":0.2}}",
            escape_json(&model),
            messages_json,
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
        Ok(PromptResponse { output, tokens: None })
    }

    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<PromptResponse, OctoError> {
        let snapshot = self.snapshot_circuit();
        if snapshot.state == ProviderCircuitState::Open {
            return Err(OctoError::Provider(self.circuit_detail(&snapshot)));
        }

        let messages_json = build_messages_json(&request);
        let model = self.resolve_model(request.model)?;
        let body = format!(
            "{{\"model\":\"{}\",\"messages\":[{}],\"temperature\":0.2,\"stream\":true}}",
            escape_json(&model),
            messages_json,
        );
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));

        match run_curl_stream_request("POST", &url, &body, self.api_token.as_deref(), on_token) {
            Ok(full_output) => {
                self.reset_circuit();
                Ok(PromptResponse {
                    output: full_output,
                    tokens: None,
                })
            }
            Err(error) => {
                let snapshot = self.record_failure(error.to_string());
                Err(OctoError::Provider(self.circuit_detail(&snapshot)))
            }
        }
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

    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<PromptResponse, OctoError> {
        let mut failures = Vec::new();

        for candidate in &self.candidates {
            match candidate.prompt_stream(request.clone(), on_token) {
                Ok(response) => return Ok(response),
                Err(error) => failures.push(format!("{} failed: {}", candidate.active_provider_id(), error)),
            }
        }

        Err(OctoError::Provider(format!(
            "all fallback providers failed for {} (stream): {}",
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
    run_native_request(method, url, body, token, None)
}

/// Native HTTP client using `ureq` — replaces curl/powershell subprocess.
fn run_native_request(
    method: &str,
    url: &str,
    body: Option<&str>,
    token: Option<&str>,
    timeout_secs: Option<u64>,
) -> Result<String, OctoError> {
    let read_timeout = timeout_secs.unwrap_or(90);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(read_timeout))
        .timeout_write(std::time::Duration::from_secs(30))
        .build();

    let mut request = match method.to_uppercase().as_str() {
        "POST" => agent.post(url),
        "PUT" => agent.put(url),
        "DELETE" => agent.delete(url),
        _ => agent.get(url),
    };

    request = request.set("Content-Type", "application/json");

    if let Some(token) = token {
        if !token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
    }

    let response = if let Some(body) = body {
        request.send_string(body)
    } else {
        request.call()
    };

    match response {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| {
                OctoError::Provider(format!("failed to read response body from {url}: {e}"))
            })?;
            Ok(text)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp.into_string().unwrap_or_default();
            Err(OctoError::Provider(format!(
                "HTTP {code} from {method} {url}: {detail}"
            )))
        }
        Err(ureq::Error::Transport(transport)) => {
            Err(OctoError::Provider(format!(
                "transport error for {method} {url}: {transport}"
            )))
        }
    }
}

/// Health probe with a short timeout (3s connect, 5s read) so the WebUI
/// /api/health endpoint stays responsive even with unreachable providers.
fn run_health_probe(url: &str, token: Option<&str>) -> Result<String, OctoError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(3))
        .timeout_read(std::time::Duration::from_secs(5))
        .timeout_write(std::time::Duration::from_secs(5))
        .build();

    let mut request = agent.get(url);
    request = request.set("Content-Type", "application/json");
    if let Some(token) = token {
        if !token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
    }

    match request.call() {
        Ok(resp) => {
            let text = resp
                .into_string()
                .map_err(|e| OctoError::Provider(format!("failed to read response body from {url}: {e}")))?;
            Ok(text)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp.into_string().unwrap_or_default();
            Err(OctoError::Provider(format!("HTTP {code} from GET {url}: {detail}")))
        }
        Err(ureq::Error::Transport(transport)) => {
            Err(OctoError::Provider(format!("transport error for GET {url}: {transport}")))
        }
    }
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

/// Native streaming HTTP request using `ureq`. Reads response body line by line,
/// parses SSE `data: {json}` lines, extracts delta content, and calls `on_token`.
/// Returns the accumulated full output text.
fn run_curl_stream_request(
    _method: &str,
    url: &str,
    body: &str,
    token: Option<&str>,
    on_token: &mut dyn FnMut(&str) -> bool,
) -> Result<String, OctoError> {
    use std::io::{BufRead, BufReader};

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(120))
        .timeout_write(std::time::Duration::from_secs(30))
        .build();

    let mut request = agent.post(url);
    request = request.set("Content-Type", "application/json");
    request = request.set("Accept", "text/event-stream");

    if let Some(token) = token {
        if !token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
    }

    let response = request.send_string(body).map_err(|e| {
        OctoError::Provider(format!("streaming request failed for {url}: {e}"))
    })?;

    let reader = BufReader::new(response.into_reader());
    let mut full_output = String::new();

    for line in reader.lines() {
        let line = line.map_err(|e| OctoError::Provider(format!("stream read error: {e}")))?;
        let trimmed = line.trim();

        if trimmed == "data: [DONE]" {
            break;
        }

        if let Some(json_str) = trimmed.strip_prefix("data: ") {
            if let Some(delta) = extract_stream_delta(json_str) {
                if !on_token(&delta) {
                    return Err(OctoError::Runtime(String::from("stream cancelled")));
                }
                full_output.push_str(&delta);
            }
        }
    }

    Ok(full_output)
}

/// Extract the `choices[0].delta.content` from a streaming SSE chunk.
fn extract_stream_delta(json_str: &str) -> Option<String> {
    let delta_marker = "\"delta\"";
    let delta_pos = json_str.find(delta_marker)?;
    let after_delta = &json_str[delta_pos..];
    extract_json_string_after(after_delta, "\"content\":\"")
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
    let mut chars = body[start..].chars();
    let mut escaped = false;
    let mut output = String::new();

    while let Some(ch) = chars.next() {
        if escaped {
            match ch {
                'n' => output.push('\n'),
                'r' => output.push('\r'),
                't' => output.push('\t'),
                'b' => output.push('\u{0008}'),
                'f' => output.push('\u{000c}'),
                '"' => output.push('"'),
                '\\' => output.push('\\'),
                '/' => output.push('/'),
                'u' => {
                    let first = decode_json_u16_escape(&mut chars)?;
                    if (0xD800..=0xDBFF).contains(&first) {
                        if chars.next()? != '\\' || chars.next()? != 'u' {
                            return None;
                        }
                        let second = decode_json_u16_escape(&mut chars)?;
                        if !(0xDC00..=0xDFFF).contains(&second) {
                            return None;
                        }
                        let scalar = 0x10000
                            + (((first as u32 - 0xD800) << 10) | (second as u32 - 0xDC00));
                        output.push(char::from_u32(scalar)?);
                    } else {
                        output.push(char::from_u32(first as u32)?);
                    }
                }
                other => output.push(other),
            }
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(output);
        } else {
            output.push(ch);
        }
    }

    None
}

fn decode_json_u16_escape(chars: &mut std::str::Chars<'_>) -> Option<u16> {
    let mut hex = String::with_capacity(4);
    for _ in 0..4 {
        hex.push(chars.next()?);
    }
    u16::from_str_radix(&hex, 16).ok()
}

/// Build a JSON messages array string from a PromptRequest.
/// Includes system_prompt (if present), history, and the current user text.
fn build_messages_json(request: &PromptRequest) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(sys) = &request.system_prompt {
        parts.push(format!(
            "{{\"role\":\"system\",\"content\":\"{}\"}}",
            escape_json(sys)
        ));
    }
    for (role, content) in &request.history {
        parts.push(format!(
            "{{\"role\":\"{}\",\"content\":\"{}\"}}",
            role.as_str(),
            escape_json(content)
        ));
    }
    parts.push(format!(
        "{{\"role\":\"user\",\"content\":\"{}\"}}",
        escape_json(&request.text)
    ));
    parts.join(",")
}

fn escape_json(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\r' => result.push_str("\\r"),
            '\n' => result.push_str("\\n"),
            '\t' => result.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                result.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => result.push(c),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(cache_suffix: &str) -> OpenAiCompatibleProvider {
        OpenAiCompatibleProvider::new(
            ProviderDescriptor {
                id: String::from("local-openai"),
                display_name: String::from("Local OpenAI-Compatible Model"),
                kind: ProviderKind::LlamaCpp,
                supports_tools: false,
                supports_streaming: false,
                capabilities: ProviderCapabilities::compatible(false, false),
            },
            format!("{DEFAULT_LOCAL_BASE_URL}/{cache_suffix}"),
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
        let provider = provider("opens-after-threshold");
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
        let provider = provider("half-open-after-cooldown");
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

    #[test]
    fn registry_exposes_ollama_descriptor() {
        let registry = ProviderRegistry::new();
        assert!(registry.all().iter().any(|provider| provider.id == "ollama" && provider.kind == ProviderKind::Ollama));
    }

    #[test]
    fn registry_exposes_linkmind_descriptor() {
        let registry = ProviderRegistry::new();
        let desc = registry.all().iter().find(|p| p.id == "linkmind");
        assert!(desc.is_some(), "linkmind descriptor should exist");
        let desc = desc.unwrap();
        assert_eq!(desc.kind, ProviderKind::LinkMind);
        assert!(desc.supports_tools);
        assert!(desc.supports_streaming);
        assert!(desc.capabilities.tool_calls);
    }

    #[test]
    fn registry_builds_linkmind_provider() {
        let registry = ProviderRegistry::new();
        let provider = registry.create_by_id_with_config(
            "linkmind",
            &RuntimeConfig {
                provider_id: Some(String::from("linkmind")),
                provider_base_url: None,
                default_model: None,
                permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
                history_limit: 24,
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
            },
        );
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().descriptor().kind, ProviderKind::LinkMind);
    }

    #[test]
    fn registry_builds_ollama_provider() {
        let registry = ProviderRegistry::new();
        let provider = registry.create_by_id_with_config(
            "ollama",
            &RuntimeConfig {
                provider_id: Some(String::from("ollama")),
                provider_base_url: None,
                default_model: None,
                permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
                history_limit: 24,
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
            },
        );
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().descriptor().kind, ProviderKind::Ollama);
    }

    #[test]
    fn extract_stream_delta_parses_sse_chunk() {
        let chunk = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let delta = super::extract_stream_delta(chunk);
        assert_eq!(delta.as_deref(), Some("Hello"));
    }

    #[test]
    fn extract_stream_delta_returns_none_for_empty_delta() {
        let chunk = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        let delta = super::extract_stream_delta(chunk);
        assert!(delta.is_none());
    }

    #[test]
    fn extract_stream_delta_preserves_utf8_content() {
        let chunk = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好，世界"},"finish_reason":null}]}"#;
        let delta = super::extract_stream_delta(chunk);
        assert_eq!(delta.as_deref(), Some("你好，世界"));
    }

    #[test]
    fn extract_message_content_decodes_unicode_escape_sequences() {
        let body = r#"{"message":{"content":"\u4f60\u597d\uff0c\u4e16\u754c"}}"#;
        let content = super::extract_message_content(body);
        assert_eq!(content.as_deref(), Some("你好，世界"));
    }

    #[test]
    fn stub_provider_prompt_stream_calls_callback() {
        let stub = StubProvider::new(ProviderDescriptor {
            id: String::from("stub-stream"),
            display_name: String::from("Stub Stream"),
            kind: ProviderKind::Stub,
            supports_tools: false,
            supports_streaming: false,
            capabilities: ProviderCapabilities::stub(),
        });
        let request = PromptRequest {
            text: String::from("test stream"),
            model: None,
            system_prompt: None,
            history: vec![],
        };
        let mut tokens = Vec::new();
        let result = stub.prompt_stream(request, &mut |token| {
            tokens.push(String::from(token));
            true
        });
        assert!(result.is_ok());
        assert_eq!(tokens.len(), 1);
        assert!(tokens[0].contains("test stream"));
    }
}
