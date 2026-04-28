use std::sync::Mutex;

use octocode_core::{
    ModelProvider, OctoError, PromptRequest, PromptResponse, ProviderCircuitState,
    ProviderCircuitStatus, ProviderDescriptor, ProviderFactory, ProviderHealth, ProviderRouteStatus,
    RuntimeConfig,
};

pub struct RuntimeProviderRouter<P> {
    descriptors: Vec<ProviderDescriptor>,
    providers: Vec<P>,
    primary_provider_id: String,
    last_active_provider_id: Mutex<String>,
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
        for provider in &self.providers {
            let provider_id = provider.descriptor().id;
            match provider.prompt(request.clone()) {
                Ok(response) => {
                    self.remember_active(&provider_id);
                    return Ok(response);
                }
                Err(error) => failures.push(format!("{provider_id} failed: {error}")),
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
        for provider in &self.providers {
            let provider_id = provider.descriptor().id;
            match provider.prompt_stream(request.clone(), on_token) {
                Ok(response) => {
                    self.remember_active(&provider_id);
                    return Ok(response);
                }
                Err(error) => failures.push(format!("{provider_id} failed: {error}")),
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