use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderCircuitState,
    ProviderCircuitStatus, ProviderDescriptor, ProviderFactory, ProviderHealth, ProviderRouteStatus,
    RuntimeConfig,
};

/// P3-E4: Exponentially-weighted moving average score for one provider.
/// Recorded automatically after every routed prompt call.
#[derive(Debug, Clone, Copy)]
pub struct ProviderEwmaScore {
    /// EWMA of observed latency in milliseconds. Lower is better.
    pub latency_ms: f64,
    /// EWMA of success rate in [0.0, 1.0]. Higher is better.
    pub success_rate: f64,
    /// Total samples observed (capped to u64::MAX).
    pub samples: u64,
}

impl Default for ProviderEwmaScore {
    fn default() -> Self {
        // Start with optimistic priors so a brand-new provider isn't
        // demoted before it has any history.
        Self {
            latency_ms: 0.0,
            success_rate: 1.0,
            samples: 0,
        }
    }
}

impl ProviderEwmaScore {
    /// EWMA decay coefficient. 0.3 favours recent samples while keeping
    /// some memory of older calls (effective horizon ~3–5 samples).
    const ALPHA: f64 = 0.3;

    fn update(&mut self, latency_ms: f64, success: bool) {
        let observed_success = if success { 1.0 } else { 0.0 };
        if self.samples == 0 {
            self.latency_ms = latency_ms;
            self.success_rate = observed_success;
        } else {
            self.latency_ms =
                Self::ALPHA * latency_ms + (1.0 - Self::ALPHA) * self.latency_ms;
            self.success_rate =
                Self::ALPHA * observed_success + (1.0 - Self::ALPHA) * self.success_rate;
        }
        self.samples = self.samples.saturating_add(1);
    }

    /// Composite score where higher is better. Combines high success
    /// rate with low latency. Latency penalty is gentle so a fast
    /// provider that fails 30% of the time still loses to a slower
    /// provider that always succeeds.
    fn rank_score(&self) -> f64 {
        let latency_penalty = (self.latency_ms / 1000.0).min(10.0);
        self.success_rate * 100.0 - latency_penalty
    }
}

pub struct RuntimeProviderRouter<P> {
    descriptors: Vec<ProviderDescriptor>,
    providers: Vec<P>,
    primary_provider_id: String,
    last_active_provider_id: Mutex<String>,
    /// P3-E4: per-provider rolling score keyed by provider id. Updated
    /// after every `prompt` / `prompt_stream` call, then consulted to
    /// reorder failover candidates so a slow or flaky provider is
    /// tried after healthier siblings.
    ewma: Mutex<HashMap<String, ProviderEwmaScore>>,
}

impl<P> RuntimeProviderRouter<P>
where
    P: ModelProvider,
{
    pub fn new(
        descriptors: Vec<ProviderDescriptor>,
        providers: Vec<P>,
        primary_provider_id: String,
    ) -> Self {
        let last_active_provider_id = primary_provider_id.clone();
        Self {
            descriptors,
            providers,
            primary_provider_id,
            last_active_provider_id: Mutex::new(last_active_provider_id),
            ewma: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_factory<F>(factory: &F, config: &RuntimeConfig) -> Result<Self, OctoError>
    where
        F: ProviderFactory<Provider = P>,
    {
        let descriptors = factory.descriptors().to_vec();
        let primary_provider_id = config
            .provider_id
            .clone()
            .or_else(|| descriptors.first().map(|descriptor| descriptor.id.clone()))
            .ok_or_else(|| OctoError::Runtime(String::from("provider registry is empty")))?;

        let mut ordered_ids = Vec::new();
        ordered_ids.push(primary_provider_id.clone());
        for descriptor in &descriptors {
            if descriptor.id != primary_provider_id && descriptor.id != "stub" {
                ordered_ids.push(descriptor.id.clone());
            }
        }
        if descriptors.iter().any(|descriptor| descriptor.id == "stub") {
            ordered_ids.push(String::from("stub"));
        }

        let mut providers = Vec::new();
        for provider_id in ordered_ids {
            if let Some(provider) = factory.create_by_id(&provider_id, config) {
                providers.push(provider);
            }
        }

        if providers.is_empty() {
            return Err(OctoError::Runtime(String::from(
                "provider router could not build any providers",
            )));
        }

        Ok(Self::new(descriptors, providers, primary_provider_id))
    }

    pub fn routing_statuses(&self) -> Vec<ProviderRouteStatus> {
        let active_provider_id = self.active_provider_id();
        self.providers
            .iter()
            .map(|provider| {
                let descriptor = provider.descriptor();
                let health = provider.health();
                ProviderRouteStatus {
                    provider_id: descriptor.id.clone(),
                    display_name: descriptor.display_name.clone(),
                    kind: descriptor.kind,
                    healthy: health.healthy,
                    circuit_state: health.circuit_state,
                    detail: health.detail,
                    latency_ms: health.latency_ms,
                    is_primary: descriptor.id == self.primary_provider_id,
                    is_active: descriptor.id == active_provider_id,
                }
            })
            .collect()
    }

    fn preferred_provider(&self) -> Option<&P> {
        self.providers.iter().find(|provider| {
            let descriptor = provider.descriptor();
            descriptor.id == self.primary_provider_id
        })
    }

    fn remember_active(&self, provider_id: &str) {
        if let Ok(mut active) = self.last_active_provider_id.lock() {
            *active = String::from(provider_id);
        }
    }

    /// P3-E4: record an EWMA observation. `success=false` is also
    /// recorded so flaky providers naturally sink in the ranking.
    fn record_ewma(&self, provider_id: &str, latency_ms: f64, success: bool) {
        if let Ok(mut map) = self.ewma.lock() {
            map.entry(String::from(provider_id))
                .or_insert_with(ProviderEwmaScore::default)
                .update(latency_ms, success);
        }
    }

    /// P3-E4: snapshot of all per-provider EWMA scores for telemetry.
    /// Returned in stable insertion order (no sort) so callers may sort
    /// however they wish.
    pub fn ewma_scores(&self) -> Vec<(String, ProviderEwmaScore)> {
        match self.ewma.lock() {
            Ok(map) => map
                .iter()
                .map(|(id, score)| (id.clone(), *score))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Build a per-call ordering of providers: primary first, then the
    /// remainder sorted by descending [`ProviderEwmaScore::rank_score`].
    /// Providers without samples retain their original config order via
    /// a stable secondary sort key.
    fn ordered_providers(&self) -> Vec<&P> {
        let scores = self.ewma.lock().ok();
        let mut indexed: Vec<(usize, &P, f64, u64)> = self
            .providers
            .iter()
            .enumerate()
            .map(|(idx, provider)| {
                let id = provider.descriptor().id;
                let (rank, samples) = scores
                    .as_ref()
                    .and_then(|map| map.get(&id))
                    .map(|score| (score.rank_score(), score.samples))
                    .unwrap_or((0.0, 0));
                (idx, provider, rank, samples)
            })
            .collect();
        // Primary stays at index 0; sort the tail by score then by
        // original config index for stability when there's no signal yet.
        let primary_id = self.primary_provider_id.clone();
        indexed.sort_by(|a, b| {
            let a_is_primary = a.1.descriptor().id == primary_id;
            let b_is_primary = b.1.descriptor().id == primary_id;
            match (a_is_primary, b_is_primary) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => {
                    // Higher rank first; if neither has samples, fall back
                    // to the original index.
                    if a.3 == 0 && b.3 == 0 {
                        a.0.cmp(&b.0)
                    } else {
                        b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)
                    }
                }
            }
        });
        indexed.into_iter().map(|(_, provider, _, _)| provider).collect()
    }
}

impl<P> ModelProvider for RuntimeProviderRouter<P>
where
    P: ModelProvider,
{
    fn descriptor(&self) -> ProviderDescriptor {
        self.preferred_provider()
            .map(ModelProvider::descriptor)
            .or_else(|| self.providers.first().map(ModelProvider::descriptor))
            .or_else(|| self.descriptors.iter().find(|descriptor| descriptor.id == self.primary_provider_id).cloned())
            .expect("provider router must have at least one descriptor")
    }

    fn prompt(&self, request: PromptRequest) -> Result<PromptResponse, OctoError> {
        let mut failures = Vec::new();
        for provider in self.ordered_providers() {
            let provider_id = provider.descriptor().id;
            let started = Instant::now();
            match provider.prompt(request.clone()) {
                Ok(response) => {
                    self.record_ewma(
                        &provider_id,
                        started.elapsed().as_millis() as f64,
                        true,
                    );
                    self.remember_active(&provider_id);
                    return Ok(response);
                }
                Err(error) => {
                    self.record_ewma(
                        &provider_id,
                        started.elapsed().as_millis() as f64,
                        false,
                    );
                    failures.push(format!("{provider_id} failed: {error}"));
                }
            }
        }

        Err(OctoError::Provider(format!(
            "all routed providers failed: {}",
            failures.join(" | ")
        )))
    }

    fn prompt_stream(
        &self,
        request: PromptRequest,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<PromptResponse, OctoError> {
        let mut failures = Vec::new();
        for provider in self.ordered_providers() {
            let provider_id = provider.descriptor().id;
            let started = Instant::now();
            match provider.prompt_stream(request.clone(), on_token) {
                Ok(response) => {
                    self.record_ewma(
                        &provider_id,
                        started.elapsed().as_millis() as f64,
                        true,
                    );
                    self.remember_active(&provider_id);
                    return Ok(response);
                }
                Err(error) => {
                    self.record_ewma(
                        &provider_id,
                        started.elapsed().as_millis() as f64,
                        false,
                    );
                    failures.push(format!("{provider_id} failed: {error}"));
                }
            }
        }

        Err(OctoError::Provider(format!(
            "all routed providers failed (stream): {}",
            failures.join(" | ")
        )))
    }

    fn active_provider_id(&self) -> String {
        self.providers
            .iter()
            .map(ModelProvider::health)
            .find(|health| health.healthy)
            .map(|health| health.provider_id)
            .or_else(|| self.last_active_provider_id.lock().ok().map(|active| active.clone()))
            .unwrap_or_else(|| self.primary_provider_id.clone())
    }

    fn health(&self) -> ProviderHealth {
        let active_provider_id = self.active_provider_id();
        self.providers
            .iter()
            .map(ModelProvider::health)
            .find(|health| health.provider_id == active_provider_id)
            .or_else(|| self.preferred_provider().map(ModelProvider::health))
            .or_else(|| self.providers.first().map(ModelProvider::health))
            .expect("provider router must have at least one provider")
    }

    fn health_catalog(&self) -> Vec<ProviderHealth> {
        // P0-S1: Probe providers in parallel using scoped threads. Each
        // candidate may issue an HTTP HEAD/health request; the previous
        // serial loop summed all latencies and could exceed 4 s on a
        // 17-provider catalog. Scoped threads give us the same `&self`
        // borrow safety while collapsing wall time to ~max(probe).
        if self.providers.len() <= 1 {
            return self.providers.iter().map(ModelProvider::health).collect();
        }
        let mut slots: Vec<Option<ProviderHealth>> = (0..self.providers.len()).map(|_| None).collect();
        std::thread::scope(|scope| {
            let mut handles = Vec::with_capacity(self.providers.len());
            for provider in &self.providers {
                handles.push(scope.spawn(move || provider.health()));
            }
            for (idx, handle) in handles.into_iter().enumerate() {
                slots[idx] = handle.join().ok();
            }
        });
        slots
            .into_iter()
            .enumerate()
            .map(|(idx, opt)| {
                opt.unwrap_or_else(|| {
                    let descriptor = self.providers[idx].descriptor();
                    ProviderHealth {
                        provider_id: descriptor.id.clone(),
                        display_name: descriptor.display_name,
                        healthy: false,
                        detail: String::from("provider health probe panicked"),
                        model: None,
                        latency_ms: None,
                        circuit_state: ProviderCircuitState::Open,
                        failure_count: 0,
                        cooldown_remaining_ms: None,
                    }
                })
            })
            .collect()
    }

    fn circuit_status(&self) -> ProviderCircuitStatus {
        let active_provider_id = self.active_provider_id();
        self.providers
            .iter()
            .map(ModelProvider::circuit_status)
            .find(|status| status.provider_id == active_provider_id)
            .or_else(|| self.preferred_provider().map(ModelProvider::circuit_status))
            .or_else(|| self.providers.first().map(ModelProvider::circuit_status))
            .unwrap_or_else(|| ProviderCircuitStatus {
                provider_id: self.primary_provider_id.clone(),
                display_name: self.descriptor().display_name,
                circuit_state: ProviderCircuitState::Open,
                failure_count: 0,
                cooldown_remaining_ms: None,
                recent_failure_reason: Some(String::from("provider router has no active circuit")),
                last_opened_at_ms: None,
                last_half_opened_at_ms: None,
                last_recovered_at_ms: None,
                event_log: Vec::new(),
            })
    }

    fn circuit_catalog(&self) -> Vec<ProviderCircuitStatus> {
        self.providers.iter().map(ModelProvider::circuit_status).collect()
    }

    fn route_statuses(&self) -> Vec<ProviderRouteStatus> {
        self.routing_statuses()
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeProviderRouter;
    use octocode_core::{
        ModelProvider, OctoError, PermissionMode, PromptRequest, PromptResponse,
        ProviderCapabilities, ProviderCircuitState, ProviderCircuitStatus, ProviderDescriptor,
        ProviderFactory, ProviderHealth, ProviderKind, RuntimeConfig,
    };

    #[derive(Clone)]
    struct FakeProvider {
        descriptor: ProviderDescriptor,
        healthy: bool,
        prompt_output: Option<&'static str>,
    }

    impl ModelProvider for FakeProvider {
        fn descriptor(&self) -> ProviderDescriptor {
            self.descriptor.clone()
        }

        fn prompt(&self, _request: PromptRequest) -> Result<PromptResponse, OctoError> {
            self.prompt_output
                .map(|output| PromptResponse {
                    output: String::from(output),
                    tokens: None,
                })
                .ok_or_else(|| OctoError::Provider(format!("{} unavailable", self.descriptor.id)))
        }

        fn health(&self) -> ProviderHealth {
            ProviderHealth {
                provider_id: self.descriptor.id.clone(),
                display_name: self.descriptor.display_name.clone(),
                healthy: self.healthy,
                detail: if self.healthy {
                    String::from("ready")
                } else {
                    String::from("down")
                },
                model: None,
                latency_ms: None,
                circuit_state: if self.healthy {
                    ProviderCircuitState::Closed
                } else {
                    ProviderCircuitState::Open
                },
                failure_count: 0,
                cooldown_remaining_ms: None,
            }
        }

        fn circuit_status(&self) -> ProviderCircuitStatus {
            ProviderCircuitStatus {
                provider_id: self.descriptor.id.clone(),
                display_name: self.descriptor.display_name.clone(),
                circuit_state: if self.healthy {
                    ProviderCircuitState::Closed
                } else {
                    ProviderCircuitState::Open
                },
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

    struct FakeFactory {
        descriptors: Vec<ProviderDescriptor>,
    }

    impl FakeFactory {
        fn provider(id: &str, healthy: bool, prompt_output: Option<&'static str>) -> FakeProvider {
            FakeProvider {
                descriptor: ProviderDescriptor {
                    id: String::from(id),
                    display_name: String::from(id),
                    kind: ProviderKind::Stub,
                    supports_tools: false,
                    supports_streaming: false,
                    capabilities: ProviderCapabilities::stub(),
                },
                healthy,
                prompt_output,
            }
        }
    }

    impl ProviderFactory for FakeFactory {
        type Provider = FakeProvider;

        fn descriptors(&self) -> &[ProviderDescriptor] {
            &self.descriptors
        }

        fn create_from_config(&self, _config: &RuntimeConfig) -> Self::Provider {
            Self::provider("primary", true, Some("primary"))
        }

        fn create_by_id(&self, id: &str, _config: &RuntimeConfig) -> Option<Self::Provider> {
            Some(match id {
                "primary" => Self::provider("primary", false, None),
                "secondary" => Self::provider("secondary", true, Some("secondary")),
                "stub" => Self::provider("stub", true, Some("stub")),
                _ => return None,
            })
        }
    }

    #[test]
    fn router_promotes_next_healthy_provider() {
        let factory = FakeFactory {
            descriptors: vec![
                FakeFactory::provider("primary", true, Some("primary")).descriptor,
                FakeFactory::provider("secondary", true, Some("secondary")).descriptor,
                FakeFactory::provider("stub", true, Some("stub")).descriptor,
            ],
        };
        let router = RuntimeProviderRouter::from_factory(
            &factory,
            &RuntimeConfig {
                provider_id: Some(String::from("primary")),
                provider_base_url: None,
                default_model: None,
                permission_mode: PermissionMode::WorkspaceWrite,
                history_limit: 8,
                denied_tools: Vec::new(),
                request_timeout_secs: 90,
                agent_max_iterations: 0,
            },
        )
        .expect("router builds");

        let response = router
            .prompt(PromptRequest {
                text: String::from("hello"),
                model: None,
                system_prompt: None,
                history: vec![],
            })
            .expect("router prompt succeeds");
        assert_eq!(response.output, "secondary");
        assert_eq!(router.active_provider_id(), "secondary");
    }
}