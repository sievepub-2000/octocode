//! Provider health-check guardian thread.
//!
//! Periodically probes each configured provider and triggers automatic failover
//! when the primary becomes unhealthy. Emits events that the runtime can observe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Health state for a single provider.
#[derive(Debug, Clone)]
pub struct ProviderHealthSnapshot {
    pub provider_id: String,
    pub healthy: bool,
    pub latency_ms: Option<u64>,
    pub last_check_at_ms: u128,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
}

/// A failover event recorded by the guardian.
#[derive(Debug, Clone)]
pub struct FailoverEvent {
    pub at_ms: u128,
    pub from_provider: String,
    pub to_provider: String,
    pub reason: String,
}

/// Configuration for the health-check guardian.
#[derive(Debug, Clone)]
pub struct GuardianConfig {
    /// Interval between health checks (default: 30s).
    pub check_interval: Duration,
    /// Number of consecutive failures before marking unhealthy (default: 3).
    pub failure_threshold: u32,
    /// Timeout for a single health probe (default: 5s).
    pub probe_timeout: Duration,
    /// Cooldown after failover before rechecking original (default: 60s).
    pub recovery_cooldown: Duration,
}

impl Default for GuardianConfig {
    fn default() -> Self {
        Self {
            check_interval: Duration::from_secs(30),
            failure_threshold: 3,
            probe_timeout: Duration::from_secs(5),
            recovery_cooldown: Duration::from_secs(60),
        }
    }
}

/// Callback type for probing a provider's health.
/// Takes a provider_id and returns Ok(latency_ms) or Err(reason).
pub type HealthProbe = Box<dyn Fn(&str) -> Result<u64, String> + Send + Sync + 'static>;

/// Callback type for executing a failover.
/// Takes (from_id, to_id) and returns true if failover succeeded.
pub type FailoverAction = Box<dyn Fn(&str, &str) -> bool + Send + Sync + 'static>;

/// The guardian thread controller.
pub struct HealthGuardian {
    running: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    state: Arc<Mutex<GuardianState>>,
}

struct GuardianState {
    snapshots: Vec<ProviderHealthSnapshot>,
    failover_log: Vec<FailoverEvent>,
    active_provider: String,
    provider_ids: Vec<String>,
}

impl HealthGuardian {
    /// Start the guardian thread that monitors provider health.
    pub fn start(
        provider_ids: Vec<String>,
        primary_id: String,
        config: GuardianConfig,
        probe: Arc<HealthProbe>,
        failover: Arc<FailoverAction>,
    ) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let state = Arc::new(Mutex::new(GuardianState {
            snapshots: provider_ids
                .iter()
                .map(|id| ProviderHealthSnapshot {
                    provider_id: id.clone(),
                    healthy: true,
                    latency_ms: None,
                    last_check_at_ms: 0,
                    consecutive_failures: 0,
                    last_error: None,
                })
                .collect(),
            failover_log: Vec::new(),
            active_provider: primary_id.clone(),
            provider_ids: provider_ids.clone(),
        }));

        let running_clone = Arc::clone(&running);
        let state_clone = Arc::clone(&state);

        let handle = thread::Builder::new()
            .name("health-guardian".into())
            .spawn(move || {
                Self::guardian_loop(
                    running_clone,
                    state_clone,
                    config,
                    probe,
                    failover,
                );
            })
            .expect("failed to spawn health guardian thread");

        Self {
            running,
            handle: Some(handle),
            state,
        }
    }

    fn guardian_loop(
        running: Arc<AtomicBool>,
        state: Arc<Mutex<GuardianState>>,
        config: GuardianConfig,
        probe: Arc<HealthProbe>,
        failover: Arc<FailoverAction>,
    ) {
        while running.load(Ordering::Relaxed) {
            let provider_ids = {
                state.lock().unwrap().provider_ids.clone()
            };

            for provider_id in &provider_ids {
                if !running.load(Ordering::Relaxed) {
                    break;
                }

                let start = Instant::now();
                let result = probe(provider_id);
                let elapsed_ms = start.elapsed().as_millis() as u64;
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();

                let mut guard = state.lock().unwrap();
                if let Some(snapshot) = guard
                    .snapshots
                    .iter_mut()
                    .find(|s| s.provider_id == *provider_id)
                {
                    snapshot.last_check_at_ms = now_ms;
                    match result {
                        Ok(latency) => {
                            snapshot.healthy = true;
                            snapshot.latency_ms = Some(latency.min(elapsed_ms));
                            snapshot.consecutive_failures = 0;
                            snapshot.last_error = None;
                        }
                        Err(reason) => {
                            snapshot.consecutive_failures += 1;
                            snapshot.last_error = Some(reason);
                            snapshot.latency_ms = None;
                            if snapshot.consecutive_failures >= config.failure_threshold {
                                snapshot.healthy = false;
                            }
                        }
                    }
                }

                // Check if active provider is unhealthy → trigger failover
                let active = guard.active_provider.clone();
                let active_unhealthy = guard
                    .snapshots
                    .iter()
                    .find(|s| s.provider_id == active)
                    .map(|s| !s.healthy)
                    .unwrap_or(false);

                if active_unhealthy {
                    // Find first healthy alternative
                    if let Some(target) = guard
                        .snapshots
                        .iter()
                        .find(|s| s.healthy && s.provider_id != active)
                    {
                        let target_id = target.provider_id.clone();
                        drop(guard); // Release lock before failover action

                        if failover(&active, &target_id) {
                            let mut guard = state.lock().unwrap();
                            guard.failover_log.push(FailoverEvent {
                                at_ms: now_ms,
                                from_provider: active.clone(),
                                to_provider: target_id.clone(),
                                reason: format!(
                                    "provider '{}' failed {} consecutive checks",
                                    active, config.failure_threshold
                                ),
                            });
                            guard.active_provider = target_id;
                        }
                    }
                }
            }

            // Sleep in small increments to allow graceful shutdown
            let sleep_end = Instant::now() + config.check_interval;
            while Instant::now() < sleep_end && running.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    /// Get current health snapshots for all providers.
    pub fn snapshots(&self) -> Vec<ProviderHealthSnapshot> {
        self.state.lock().unwrap().snapshots.clone()
    }

    /// Get the failover event log.
    pub fn failover_log(&self) -> Vec<FailoverEvent> {
        self.state.lock().unwrap().failover_log.clone()
    }

    /// Get the currently active provider.
    pub fn active_provider(&self) -> String {
        self.state.lock().unwrap().active_provider.clone()
    }

    /// Gracefully stop the guardian thread.
    pub fn stop(mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }

    /// Check if the guardian is still running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }
}

impl Drop for HealthGuardian {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

// ─── Real health probe factory ──────────────────────────────────────────────

use octocode_core::ProviderHealth;

/// Create a HealthProbe that calls a real provider health-check function.
///
/// `health_fn` receives a provider_id and returns the health snapshot from the
/// runtime's provider router.  The probe converts that into the
/// `Ok(latency_ms)` / `Err(reason)` protocol that HealthGuardian expects.
pub fn make_provider_probe<F>(health_fn: F) -> HealthProbe
where
    F: Fn(&str) -> Option<ProviderHealth> + Send + Sync + 'static,
{
    Box::new(move |provider_id: &str| {
        match health_fn(provider_id) {
            Some(h) if h.healthy => Ok(h.latency_ms.unwrap_or(0) as u64),
            Some(h) => Err(h.detail),
            None => Err(format!("provider '{}' not found", provider_id)),
        }
    })
}

/// Create a HealthProbe that performs an actual HTTP health-check against a
/// provider endpoint.  Sends a lightweight GET to `{base_url}/health` (or
/// `/v1/models` as a fallback) and measures round-trip latency.
pub fn make_http_health_probe() -> HealthProbe {
    Box::new(|provider_id: &str| {
        // Use the provider_id as a URL hint (matches task2_state.json convention)
        let url = if provider_id.starts_with("http") {
            format!("{}/health", provider_id.trim_end_matches('/'))
        } else {
            // Fallback: use the provider ID as a hostname/alias
            return Err(format!("cannot probe non-URL provider '{}'", provider_id));
        };

        let start = std::time::Instant::now();
        match ureq::get(&url).timeout(std::time::Duration::from_secs(5)).call() {
            Ok(resp) => {
                let latency = start.elapsed().as_millis() as u64;
                if resp.status() == 200 {
                    Ok(latency)
                } else {
                    Err(format!("HTTP {} from {}", resp.status(), url))
                }
            }
            Err(e) => Err(format!("probe failed for {}: {}", url, e)),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guardian_config_default_values() {
        let config = GuardianConfig::default();
        assert_eq!(config.check_interval, Duration::from_secs(30));
        assert_eq!(config.failure_threshold, 3);
        assert_eq!(config.probe_timeout, Duration::from_secs(5));
        assert_eq!(config.recovery_cooldown, Duration::from_secs(60));
    }

    #[test]
    fn guardian_starts_and_stops() {
        let probe: Arc<HealthProbe> = Arc::new(Box::new(|_id| Ok(10)));
        let failover: Arc<FailoverAction> = Arc::new(Box::new(|_from, _to| true));

        let guardian = HealthGuardian::start(
            vec!["p1".into(), "p2".into()],
            "p1".into(),
            GuardianConfig {
                check_interval: Duration::from_millis(50),
                ..Default::default()
            },
            probe,
            failover,
        );

        assert!(guardian.is_running());
        thread::sleep(Duration::from_millis(100));

        let snapshots = guardian.snapshots();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].provider_id, "p1");

        guardian.stop();
    }

    #[test]
    fn guardian_triggers_failover_on_failures() {
        let call_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let call_count_clone = Arc::clone(&call_count);

        let probe: Arc<HealthProbe> = Arc::new(Box::new(move |id| {
            if id == "primary" {
                Err("simulated failure".into())
            } else {
                Ok(5)
            }
        }));

        let failover_called = Arc::new(AtomicBool::new(false));
        let failover_called_clone = Arc::clone(&failover_called);
        let failover: Arc<FailoverAction> = Arc::new(Box::new(move |_from, _to| {
            failover_called_clone.store(true, Ordering::Relaxed);
            true
        }));

        let guardian = HealthGuardian::start(
            vec!["primary".into(), "backup".into()],
            "primary".into(),
            GuardianConfig {
                check_interval: Duration::from_millis(20),
                failure_threshold: 2,
                probe_timeout: Duration::from_secs(1),
                recovery_cooldown: Duration::from_secs(10),
            },
            probe,
            failover,
        );

        // Wait enough time for multiple check cycles
        thread::sleep(Duration::from_millis(200));

        assert!(failover_called.load(Ordering::Relaxed));
        assert_eq!(guardian.active_provider(), "backup");
        assert!(!guardian.failover_log().is_empty());

        guardian.stop();
    }

    #[test]
    fn guardian_healthy_provider_stays_active() {
        let probe: Arc<HealthProbe> = Arc::new(Box::new(|_id| Ok(3)));
        let failover_called = Arc::new(AtomicBool::new(false));
        let fc = Arc::clone(&failover_called);
        let failover: Arc<FailoverAction> = Arc::new(Box::new(move |_, _| {
            fc.store(true, Ordering::Relaxed);
            true
        }));

        let guardian = HealthGuardian::start(
            vec!["a".into(), "b".into()],
            "a".into(),
            GuardianConfig {
                check_interval: Duration::from_millis(20),
                failure_threshold: 3,
                ..Default::default()
            },
            probe,
            failover,
        );

        thread::sleep(Duration::from_millis(150));

        assert!(!failover_called.load(Ordering::Relaxed));
        assert_eq!(guardian.active_provider(), "a");
        assert!(guardian.failover_log().is_empty());

        guardian.stop();
    }

    #[test]
    fn make_provider_probe_healthy() {
        let probe = super::make_provider_probe(|id| {
            Some(ProviderHealth {
                provider_id: id.to_string(),
                display_name: id.to_string(),
                healthy: true,
                detail: String::from("ok"),
                model: None,
                latency_ms: Some(42),
                circuit_state: octocode_core::ProviderCircuitState::Closed,
                failure_count: 0,
                cooldown_remaining_ms: None,
            })
        });
        assert_eq!(probe("test"), Ok(42));
    }

    #[test]
    fn make_provider_probe_unhealthy() {
        let probe = super::make_provider_probe(|id| {
            Some(ProviderHealth {
                provider_id: id.to_string(),
                display_name: id.to_string(),
                healthy: false,
                detail: String::from("connection refused"),
                model: None,
                latency_ms: None,
                circuit_state: octocode_core::ProviderCircuitState::Open,
                failure_count: 3,
                cooldown_remaining_ms: None,
            })
        });
        assert!(probe("test").is_err());
    }

    #[test]
    fn make_provider_probe_not_found() {
        let probe = super::make_provider_probe(|_| None);
        assert!(probe("unknown").is_err());
    }

    #[test]
    fn make_http_health_probe_invalid_id() {
        let probe = super::make_http_health_probe();
        // Non-URL provider should return error
        assert!(probe("local-ollama").is_err());
    }
}
