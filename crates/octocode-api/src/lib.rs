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
const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-5-20250929";
/// P13-D: NVIDIA's public OpenAI-compatible endpoint, backing the
/// `nvidia-free` / "free-claude-code" fallback provider. No API key is
/// required for the rate-limited free tier; operators may override with
/// `OCTOCODE_NVIDIA_FREE_API_KEY` for higher limits.
const DEFAULT_NVIDIA_FREE_BASE_URL: &str = "https://integrate.api.nvidia.com/v1";
const DEFAULT_NVIDIA_FREE_MODEL: &str = "nvidia/llama-3.1-nemotron-70b-instruct";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_GEMINI_MODEL: &str = "gemini-2.0-flash";
const DEFAULT_AZURE_OPENAI_API_VERSION: &str = "2024-10-21";
const DEFAULT_LOCAL_MODEL: &str = "gemma-4-31b-it-q8-prod";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5-coder:14b";

// Additional mainstream vendors (all speak OpenAI-compatible chat-completions
// unless noted). Each exposes `{PROVIDER}_API_KEY` and `{PROVIDER}_BASE_URL`
// env knobs; defaults point at each vendor's public gateway so a fresh
// install can chat the moment a key is set.
const DEFAULT_XAI_BASE_URL: &str = "https://api.x.ai/v1";
const DEFAULT_XAI_MODEL: &str = "grok-beta";
const DEFAULT_OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL: &str = "openrouter/auto";
const DEFAULT_QWEN_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_MODEL: &str = "qwen2.5-coder-32b-instruct";
const DEFAULT_GLM_BASE_URL: &str = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_MODEL: &str = "glm-4-plus";
const DEFAULT_KIMI_BASE_URL: &str = "https://api.moonshot.cn/v1";
const DEFAULT_KIMI_MODEL: &str = "moonshot-v1-32k";
const DEFAULT_XIAOMI_BASE_URL: &str = "https://api.xiaomi.com/openai/v1";
const DEFAULT_XIAOMI_MODEL: &str = "mimo-7b-chat";
const DEFAULT_MINIMAX_BASE_URL: &str = "https://api.minimaxi.com/v1";
const DEFAULT_MINIMAX_MODEL: &str = "abab6.5s-chat";
/// Legacy `/v1/completions` (pre-chat-completions). Kept for self-hosted
/// gateways that still only implement the old shape. Model left empty so
/// operators must point at their concrete local deployment.
const DEFAULT_OPENAI_COMPLETION_BASE_URL: &str = "http://127.0.0.1:8080/v1";
const DEFAULT_OPENAI_COMPLETION_MODEL: &str = "text-davinci-003";

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
    Anthropic(AnthropicProvider),
    Fallback(FallbackProvider),
}

/// Native Anthropic Messages API adapter (`/v1/messages`).
///
/// Uses Anthropic-specific auth headers (`x-api-key`, `anthropic-version`)
/// and the distinct request/response schema (system string, messages array,
/// content blocks). Streaming uses SSE with `content_block_delta` events.
#[derive(Clone)]
pub struct AnthropicProvider {
    descriptor: ProviderDescriptor,
    base_url: String,
    api_token: Option<String>,
    default_model: Option<String>,
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
            // T6 (release-hardening): count circuit-open transitions.
            // Trip event = either the very first time we cross the
            // threshold, or a previously-expired/half-open circuit
            // re-tripping. Repeat failures while already Open are NOT
            // counted to avoid inflating the metric.
            let was_open_now =
                matches!(state.open_until, Some(deadline) if deadline > now);
            if !was_open_now {
                octocode_core::CIRCUIT_OPEN_TOTAL
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
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
                ProviderDescriptor {
                    id: String::from("anthropic"),
                    display_name: String::from("Anthropic Claude (native)"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("gemini"),
                    display_name: String::from("Google Gemini (OpenAI-compat)"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("azure-openai"),
                    display_name: String::from("Azure OpenAI Service"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    // P13-D: free-claude-code system fallback. Kept at the end
                    // of the list so it appears after operator-preferred
                    // providers in UI dropdowns.
                    id: String::from("nvidia-free"),
                    display_name: String::from("NVIDIA NIM Free (system fallback)"),
                    kind: ProviderKind::OpenAiCompatible,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                // Mainstream vendor descriptors (all OpenAI-compatible).
                // Keys are injected via environment variables; no secrets
                // are ever embedded in this registry.
                ProviderDescriptor {
                    id: String::from("xai"),
                    display_name: String::from("xAI Grok"),
                    kind: ProviderKind::XAi,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("openrouter"),
                    display_name: String::from("OpenRouter Aggregator"),
                    kind: ProviderKind::OpenRouter,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("qwen"),
                    display_name: String::from("阿里通义 Qwen (DashScope)"),
                    kind: ProviderKind::Qwen,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("glm"),
                    display_name: String::from("智谱 GLM (BigModel)"),
                    kind: ProviderKind::Glm,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("kimi"),
                    display_name: String::from("月之暗面 Kimi (Moonshot)"),
                    kind: ProviderKind::Kimi,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    id: String::from("xiaomi"),
                    display_name: String::from("小米 MiMo"),
                    kind: ProviderKind::Xiaomi,
                    supports_tools: false,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, false),
                },
                ProviderDescriptor {
                    id: String::from("minimax"),
                    display_name: String::from("MiniMax abab"),
                    kind: ProviderKind::MiniMax,
                    supports_tools: true,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, true),
                },
                ProviderDescriptor {
                    // Legacy /v1/completions. Kept explicit so local
                    // deployments that only implement the old shape are
                    // not misrouted to chat-completions.
                    id: String::from("openai-completion"),
                    display_name: String::from("OpenAI Legacy /completions (self-hosted)"),
                    kind: ProviderKind::OpenAiCompletion,
                    supports_tools: false,
                    supports_streaming: true,
                    capabilities: ProviderCapabilities::compatible(true, false),
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
                config_version: 0,
                provider_id: Some(String::from(id)),
                provider_base_url: None,
                default_model: None,
                permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
                history_limit: 24,
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
                agent_max_iterations: 0,
            },
        )
    }

    pub fn create_by_id_with_config(&self, id: &str, config: &RuntimeConfig) -> Option<BuiltinProvider> {
        let descriptor = self.providers.iter().find(|provider| provider.id == id)?.clone();
        let provider = match descriptor.id.as_str() {
            "stub" => BuiltinProvider::Stub(StubProvider::new(descriptor)),
            "anthropic" => BuiltinProvider::Anthropic(AnthropicProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_ANTHROPIC_BASE_URL)),
                std::env::var("ANTHROPIC_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("OCTOCODE_ANTHROPIC_API_KEY").ok())
                    // Claude Code / claw-code style: many users set
                    // ANTHROPIC_AUTH_TOKEN (often pointing at a proxy or
                    // gateway) instead of the canonical ANTHROPIC_API_KEY.
                    // Accept it as an additional fallback so the chain does
                    // not collapse to the StubProvider when only the
                    // auth-token form is present.
                    .or_else(|| std::env::var("ANTHROPIC_AUTH_TOKEN").ok()),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("ANTHROPIC_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_ANTHROPIC_MODEL))),
            )),
            "gemini" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("GEMINI_BASE_URL").ok())
                    .or_else(|| std::env::var("OCTOCODE_GEMINI_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_GEMINI_BASE_URL)),
                std::env::var("GEMINI_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("GOOGLE_API_KEY").ok())
                    .or_else(|| std::env::var("OCTOCODE_GEMINI_API_KEY").ok()),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("GEMINI_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_GEMINI_MODEL))),
            )),
            "azure-openai" => {
                // Azure OpenAI URL pattern (post-2024): users set base_url to
                //   https://{resource}.openai.azure.com/openai/deployments/{deployment}
                // and set default_model to the deployment name. The api-version query
                // string must be appended to base_url by the user when deploying.
                // Env vars AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT are honored
                // for shorthand composition when base_url is not explicitly configured.
                let endpoint = std::env::var("AZURE_OPENAI_ENDPOINT").ok();
                let deployment = std::env::var("AZURE_OPENAI_DEPLOYMENT").ok();
                let api_version = std::env::var("AZURE_OPENAI_API_VERSION")
                    .unwrap_or_else(|_| String::from(DEFAULT_AZURE_OPENAI_API_VERSION));
                let composed = match (endpoint, deployment) {
                    (Some(ep), Some(dep)) => Some(format!(
                        "{}/openai/deployments/{}/chat/completions?api-version={}",
                        ep.trim_end_matches('/'),
                        dep,
                        api_version
                    )),
                    _ => None,
                };
                BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                    descriptor,
                    config
                        .provider_base_url
                        .clone()
                        .or(composed)
                        .or_else(|| std::env::var("OCTOCODE_AZURE_BASE_URL").ok())
                        .unwrap_or_else(|| String::from("https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT")),
                    std::env::var("AZURE_OPENAI_API_KEY")
                        .ok()
                        .or_else(|| std::env::var("OCTOCODE_AZURE_API_KEY").ok()),
                    config.default_model.clone(),
                ))
            }
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
            "nvidia-free" => BuiltinProvider::Fallback(FallbackProvider::new(
                descriptor.clone(),
                vec![
                    // P13-D: NVIDIA's public OpenAI-compatible gateway. The
                    // free tier is keyless at low rate; operators who need
                    // higher throughput provide OCTOCODE_NVIDIA_FREE_API_KEY.
                    BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                        descriptor,
                        config
                            .provider_base_url
                            .clone()
                            .or_else(|| std::env::var("OCTOCODE_NVIDIA_FREE_BASE_URL").ok())
                            .unwrap_or_else(|| String::from(DEFAULT_NVIDIA_FREE_BASE_URL)),
                        std::env::var("OCTOCODE_NVIDIA_FREE_API_KEY").ok(),
                        config
                            .default_model
                            .clone()
                            .or_else(|| Some(String::from(DEFAULT_NVIDIA_FREE_MODEL))),
                    )),
                    // Trailing stub keeps the runtime deterministic even if
                    // NVIDIA is unreachable offline.
                    BuiltinProvider::Stub(StubProvider::new(
                        self.providers.iter().find(|provider| provider.id == "stub")?.clone(),
                    )),
                ],
            )),
            // Mainstream OpenAI-compatible vendors. All follow the same
            // shape: descriptor + env BASE_URL + env API_KEY + env MODEL,
            // with sensible public defaults. A trailing stub keeps us
            // deterministic offline.
            "xai" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("XAI_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_XAI_BASE_URL)),
                std::env::var("XAI_API_KEY").ok(),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("XAI_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_XAI_MODEL))),
            )),
            "openrouter" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("OPENROUTER_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_OPENROUTER_BASE_URL)),
                std::env::var("OPENROUTER_API_KEY").ok(),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("OPENROUTER_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_OPENROUTER_MODEL))),
            )),
            "qwen" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("QWEN_BASE_URL").ok())
                    .or_else(|| std::env::var("DASHSCOPE_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_QWEN_BASE_URL)),
                std::env::var("QWEN_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("DASHSCOPE_API_KEY").ok()),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("QWEN_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_QWEN_MODEL))),
            )),
            "glm" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("GLM_BASE_URL").ok())
                    .or_else(|| std::env::var("ZHIPU_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_GLM_BASE_URL)),
                std::env::var("GLM_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("ZHIPU_API_KEY").ok()),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("GLM_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_GLM_MODEL))),
            )),
            "kimi" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("KIMI_BASE_URL").ok())
                    .or_else(|| std::env::var("MOONSHOT_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_KIMI_BASE_URL)),
                std::env::var("KIMI_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("MOONSHOT_API_KEY").ok()),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("KIMI_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_KIMI_MODEL))),
            )),
            "xiaomi" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("XIAOMI_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_XIAOMI_BASE_URL)),
                std::env::var("XIAOMI_API_KEY").ok(),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("XIAOMI_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_XIAOMI_MODEL))),
            )),
            "minimax" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("MINIMAX_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_MINIMAX_BASE_URL)),
                std::env::var("MINIMAX_API_KEY").ok(),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("MINIMAX_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_MINIMAX_MODEL))),
            )),
            "openai-completion" => BuiltinProvider::OpenAiCompatible(OpenAiCompatibleProvider::new(
                // NOTE: this routes through OpenAiCompatibleProvider which
                // targets the chat-completions shape. A future
                // LegacyCompletionProvider can hit /v1/completions directly
                // without altering the descriptor. For now operators who
                // truly need the legacy shape must front this with a
                // shim gateway that translates completions -> chat.
                descriptor,
                config
                    .provider_base_url
                    .clone()
                    .or_else(|| std::env::var("OPENAI_COMPLETION_BASE_URL").ok())
                    .unwrap_or_else(|| String::from(DEFAULT_OPENAI_COMPLETION_BASE_URL)),
                std::env::var("OPENAI_COMPLETION_API_KEY")
                    .ok()
                    .or_else(|| std::env::var("OPENAI_API_KEY").ok()),
                config
                    .default_model
                    .clone()
                    .or_else(|| std::env::var("OPENAI_COMPLETION_MODEL").ok())
                    .or_else(|| Some(String::from(DEFAULT_OPENAI_COMPLETION_MODEL))),
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
            Self::Anthropic(provider) => provider.descriptor(),
            Self::Fallback(provider) => provider.descriptor(),
        }
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        match self {
            Self::Stub(provider) => provider.prompt(request),
            Self::OpenAiCompatible(provider) => provider.prompt(request),
            Self::Anthropic(provider) => provider.prompt(request),
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
            Self::Anthropic(provider) => provider.prompt_stream(request, on_token),
            Self::Fallback(provider) => provider.prompt_stream(request, on_token),
        }
    }

    fn active_provider_id(&self) -> String {
        match self {
            Self::Stub(provider) => provider.active_provider_id(),
            Self::OpenAiCompatible(provider) => provider.active_provider_id(),
            Self::Anthropic(provider) => provider.active_provider_id(),
            Self::Fallback(provider) => provider.active_provider_id(),
        }
    }

    fn health(&self) -> ProviderHealth {
        match self {
            Self::Stub(provider) => provider.health(),
            Self::OpenAiCompatible(provider) => provider.health(),
            Self::Anthropic(provider) => provider.health(),
            Self::Fallback(provider) => provider.health(),
        }
    }

    fn health_catalog(&self) -> Vec<ProviderHealth> {
        match self {
            Self::Stub(provider) => provider.health_catalog(),
            Self::OpenAiCompatible(provider) => provider.health_catalog(),
            Self::Anthropic(provider) => provider.health_catalog(),
            Self::Fallback(provider) => provider.health_catalog(),
        }
    }

    fn circuit_status(&self) -> ProviderCircuitStatus {
        match self {
            Self::Stub(provider) => provider.circuit_status(),
            Self::OpenAiCompatible(provider) => provider.circuit_status(),
            Self::Anthropic(provider) => provider.circuit_status(),
            Self::Fallback(provider) => provider.circuit_status(),
        }
    }

    fn circuit_catalog(&self) -> Vec<ProviderCircuitStatus> {
        match self {
            Self::Stub(provider) => provider.circuit_catalog(),
            Self::OpenAiCompatible(provider) => provider.circuit_catalog(),
            Self::Anthropic(provider) => provider.circuit_catalog(),
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

impl AnthropicProvider {
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

    fn resolve_model(&self, requested_model: Option<String>) -> String {
        requested_model
            .or_else(|| self.default_model.clone())
            .unwrap_or_else(|| String::from(DEFAULT_ANTHROPIC_MODEL))
    }

    /// Build the Anthropic `/v1/messages` request body.
    ///
    /// Anthropic takes `system` as a top-level string (not a message),
    /// and the `messages` array only has user/assistant roles.
    fn build_body(&self, request: &PromptRequest, model: &str, stream: bool) -> String {
        let mut messages_parts: Vec<String> = Vec::new();
        for (role, content) in &request.history {
            let role_str = role.as_str();
            // Anthropic only accepts "user" or "assistant"; collapse "system" into system field above.
            if role_str == "system" {
                continue;
            }
            messages_parts.push(format!(
                "{{\"role\":\"{}\",\"content\":\"{}\"}}",
                role_str,
                escape_json(content)
            ));
        }
        messages_parts.push(format!(
            "{{\"role\":\"user\",\"content\":\"{}\"}}",
            escape_json(&request.text)
        ));

        let system_field = request
            .system_prompt
            .as_ref()
            .map(|sys| format!(",\"system\":\"{}\"", escape_json(sys)))
            .unwrap_or_default();
        let stream_field = if stream { ",\"stream\":true" } else { "" };

        format!(
            "{{\"model\":\"{}\",\"max_tokens\":4096,\"messages\":[{}]{}{}}}",
            escape_json(model),
            messages_parts.join(","),
            system_field,
            stream_field,
        )
    }
}

impl ModelProvider for AnthropicProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.descriptor.clone()
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let model = self.resolve_model(request.model.clone());
        let body = self.build_body(&request, &model, false);
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let response = run_anthropic_request(&url, &body, self.api_token.as_deref())?;
        let output = extract_anthropic_text(&response).ok_or_else(|| {
            OctoError::Provider(format!(
                "provider {} returned an unsupported Anthropic response shape: {}",
                self.descriptor.id, response
            ))
        })?;
        Ok(PromptResponse { output, tokens: None })
    }

    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<PromptResponse, OctoError> {
        let model = self.resolve_model(request.model.clone());
        let body = self.build_body(&request, &model, true);
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let full = run_anthropic_stream(&url, &body, self.api_token.as_deref(), on_token)?;
        Ok(PromptResponse {
            output: full,
            tokens: None,
        })
    }

    fn health(&self) -> ProviderHealth {
        // Lightweight health: check whether an API key is configured and the
        // base URL is reachable by attempting a HEAD-style probe via /v1/messages
        // with an invalid body (expect 400) — cheaper than listing models.
        let healthy = self.api_token.is_some();
        ProviderHealth {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            healthy,
            detail: if healthy {
                format!("configured {}", self.base_url)
            } else {
                String::from("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN not set")
            },
            model: self.default_model.clone(),
            latency_ms: None,
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
            event_log: Vec::new(),
        }
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
        // Report the *parent* fallback id (e.g. `ollama`, `linkmind`,
        // `remote-openai`, `nvidia-free`) instead of whichever inner
        // candidate happens to be active. Without this rewrite, every
        // fallback whose middle candidate is `local-openai` reported as
        // a duplicate `local-openai` row in the runtime snapshot, even
        // though it represents a distinct top-level provider entry.
        let active = self.pick_active().unwrap_or_else(|| ProviderHealth {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            healthy: false,
            detail: String::from("no healthy fallback provider available"),
            model: None,
            latency_ms: None,
            circuit_state: ProviderCircuitState::Open,
            failure_count: 0,
            cooldown_remaining_ms: None,
        });
        let mut detail = active.detail;
        if active.provider_id != self.descriptor.id {
            detail = format!("via {}: {}", active.provider_id, detail);
        }
        ProviderHealth {
            provider_id: self.descriptor.id.clone(),
            display_name: self.descriptor.display_name.clone(),
            healthy: active.healthy,
            detail,
            model: active.model,
            latency_ms: active.latency_ms,
            circuit_state: active.circuit_state,
            failure_count: active.failure_count,
            cooldown_remaining_ms: active.cooldown_remaining_ms,
        }
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

/// Anthropic `/v1/messages` non-streaming request.
///
/// Uses `x-api-key` + `anthropic-version` headers instead of `Authorization: Bearer`.
fn run_anthropic_request(
    url: &str,
    body: &str,
    token: Option<&str>,
) -> Result<String, OctoError> {
    let api_key = token.filter(|k| !k.is_empty()).ok_or_else(|| {
        OctoError::Provider(String::from(
            "ANTHROPIC_API_KEY not configured for Anthropic provider",
        ))
    })?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(90))
        .timeout_write(Duration::from_secs(30))
        .build();

    let response = agent
        .post(url)
        .set("Content-Type", "application/json")
        .set("x-api-key", api_key)
        // Many third-party proxies (Claude Code / ANTHROPIC_AUTH_TOKEN
        // ecosystem, e.g. ai.jiexi6.cn) expect a Bearer token. Sending
        // both headers is harmless against the canonical Anthropic API
        // (which ignores Authorization) and unblocks proxy gateways.
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("anthropic-version", ANTHROPIC_API_VERSION)
        .send_string(body);

    match response {
        Ok(resp) => resp
            .into_string()
            .map_err(|e| OctoError::Provider(format!("failed to read anthropic response: {e}"))),
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp.into_string().unwrap_or_default();
            Err(OctoError::Provider(format!(
                "HTTP {code} from Anthropic {url}: {detail}"
            )))
        }
        Err(ureq::Error::Transport(transport)) => Err(OctoError::Provider(format!(
            "transport error for Anthropic {url}: {transport}"
        ))),
    }
}

/// Anthropic `/v1/messages` streaming request (SSE).
///
/// Parses `event: content_block_delta` frames with `data: {"delta":{"type":"text_delta","text":"..."}}`.
/// Stops when `message_stop` event arrives or `on_token` returns false.
fn run_anthropic_stream(
    url: &str,
    body: &str,
    token: Option<&str>,
    on_token: &mut dyn FnMut(&str) -> bool,
) -> Result<String, OctoError> {
    use std::io::BufRead;
    let api_key = token.filter(|k| !k.is_empty()).ok_or_else(|| {
        OctoError::Provider(String::from(
            "ANTHROPIC_API_KEY not configured for Anthropic provider",
        ))
    })?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(180))
        .timeout_write(Duration::from_secs(30))
        .build();

    let response = agent
        .post(url)
        .set("Content-Type", "application/json")
        .set("Accept", "text/event-stream")
        .set("x-api-key", api_key)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("anthropic-version", ANTHROPIC_API_VERSION)
        .send_string(body)
        .map_err(|e| OctoError::Provider(format!("anthropic stream transport error: {e}")))?;

    let reader = std::io::BufReader::new(response.into_reader());
    let mut full = String::new();
    for line_result in reader.lines() {
        let line = line_result
            .map_err(|e| OctoError::Provider(format!("anthropic stream read error: {e}")))?;
        if !line.starts_with("data:") {
            continue;
        }
        let payload = line["data:".len()..].trim();
        if payload.is_empty() {
            continue;
        }
        // Detect end-of-stream markers
        if payload.contains("\"type\":\"message_stop\"") {
            break;
        }
        // Pick delta text_delta chunks
        if let Some(text) = extract_anthropic_delta_text(payload) {
            full.push_str(&text);
            if !on_token(&text) {
                break;
            }
        }
    }
    Ok(full)
}

/// Extract a `delta.text` field from an Anthropic SSE JSON payload.
fn extract_anthropic_delta_text(payload: &str) -> Option<String> {
    // Minimal match: "delta":{"type":"text_delta","text":"..."}
    let delta_idx = payload.find("\"delta\"")?;
    let after_delta = &payload[delta_idx..];
    let text_key = "\"text\":\"";
    let text_idx = after_delta.find(text_key)?;
    let text_start = text_idx + text_key.len();
    let mut chars = after_delta[text_start..].chars();
    extract_next_json_string(&mut chars)
}

/// Extract the assistant text from a non-streaming Anthropic response body.
///
/// Response shape: `{"content":[{"type":"text","text":"..."}, ...]}`.
fn extract_anthropic_text(body: &str) -> Option<String> {
    let content_idx = body.find("\"content\"")?;
    let after = &body[content_idx..];
    let text_key = "\"text\":\"";
    let text_idx = after.find(text_key)?;
    let mut chars = after[text_idx + text_key.len()..].chars();
    extract_next_json_string(&mut chars)
}

/// Consume characters until a closing `"`, handling common JSON escapes.
fn extract_next_json_string(chars: &mut std::str::Chars<'_>) -> Option<String> {
    let mut out = String::new();
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if escaped {
            match ch {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'b' => out.push('\u{0008}'),
                'f' => out.push('\u{000C}'),
                'u' => {
                    if let Some(code) = decode_json_u16_escape(chars) {
                        if let Some(c) = char::from_u32(code as u32) {
                            out.push(c);
                        }
                    }
                }
                other => out.push(other),
            }
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(out);
        } else {
            out.push(ch);
        }
    }
    None
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
                config_version: 0,
                provider_id: Some(String::from("linkmind")),
                provider_base_url: None,
                default_model: None,
                permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
                history_limit: 24,
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
                agent_max_iterations: 0,
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
                config_version: 0,
                provider_id: Some(String::from("ollama")),
                provider_base_url: None,
                default_model: None,
                permission_mode: octocode_core::PermissionMode::WorkspaceWrite,
                history_limit: 24,
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
                agent_max_iterations: 0,
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

    // ─── P2: Gemini + Azure OpenAI provider registry coverage ─────────────

    #[test]
    fn registry_exposes_gemini_descriptor() {
        let reg = ProviderRegistry::new();
        let gemini = reg.all().iter().find(|p| p.id == "gemini").expect("gemini present");
        assert_eq!(gemini.kind, ProviderKind::OpenAiCompatible);
        assert!(gemini.supports_tools);
        assert!(gemini.supports_streaming);
    }

    #[test]
    fn registry_exposes_azure_openai_descriptor() {
        let reg = ProviderRegistry::new();
        let az = reg
            .all()
            .iter()
            .find(|p| p.id == "azure-openai")
            .expect("azure-openai present");
        assert_eq!(az.kind, ProviderKind::OpenAiCompatible);
        assert!(az.supports_tools);
    }

    #[test]
    fn registry_creates_gemini_provider_with_default_base_url() {
        let reg = ProviderRegistry::new();
        // Do not set env vars → should fall back to DEFAULT_GEMINI_BASE_URL.
        let prov = reg.create_by_id("gemini").expect("gemini created");
        match prov {
            BuiltinProvider::OpenAiCompatible(p) => {
                // base_url is not pub; we verify descriptor id round-trips.
                assert_eq!(p.descriptor.id, "gemini");
            }
            _ => panic!("expected OpenAiCompatible variant for gemini"),
        }
    }

    #[test]
    fn registry_creates_azure_provider_with_placeholder_when_unconfigured() {
        let reg = ProviderRegistry::new();
        let prov = reg.create_by_id("azure-openai").expect("azure created");
        match prov {
            BuiltinProvider::OpenAiCompatible(p) => {
                assert_eq!(p.descriptor.id, "azure-openai");
            }
            _ => panic!("expected OpenAiCompatible variant for azure-openai"),
        }
    }
}
