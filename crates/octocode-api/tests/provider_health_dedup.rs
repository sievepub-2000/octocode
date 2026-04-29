//! Regression: provider health dedup.
//!
//! Locks the invariant that fallback providers project the **parent**
//! descriptor id (e.g. `ollama`, `linkmind`, `remote-openai`,
//! `nvidia-free`) instead of whichever inner candidate happens to be
//! active. Before the fix, every fallback whose middle candidate was
//! `local-openai` reported as a duplicate `local-openai` row in the
//! runtime snapshot.

use octocode_api::ProviderRegistry;
use octocode_core::{ModelProvider, PermissionMode, RuntimeConfig};

fn test_config() -> RuntimeConfig {
    RuntimeConfig {
        config_version: 1,
        provider_id: Some("local-openai".into()),
        provider_base_url: None,
        default_model: None,
        permission_mode: PermissionMode::ReadOnly,
        history_limit: 100,
        denied_tools: Vec::new(),
        request_timeout_secs: 90,
        agent_max_iterations: 0,
    }
}

#[test]
fn fallback_providers_project_parent_id() {
    let registry = ProviderRegistry::new();
    let cfg = test_config();

    for id in ["ollama", "linkmind", "remote-openai", "nvidia-free"] {
        let provider = registry
            .create_by_id_with_config(id, &cfg)
            .unwrap_or_else(|| panic!("create_by_id_with_config({id})"));
        let health = provider.health();
        assert_eq!(
            health.provider_id, id,
            "fallback provider `{id}` health() must project parent id, got `{}`",
            health.provider_id
        );
    }
}

#[test]
fn snapshot_health_ids_are_unique() {
    let registry = ProviderRegistry::new();
    let cfg = test_config();

    let mut ids: Vec<String> = registry
        .all()
        .iter()
        .filter_map(|d| registry.create_by_id_with_config(&d.id, &cfg))
        .map(|p| p.health().provider_id)
        .collect();
    ids.sort();
    let mut deduped = ids.clone();
    deduped.dedup();
    assert_eq!(
        ids, deduped,
        "provider health ids must be unique (no duplicate rows in /api/state)"
    );
}
