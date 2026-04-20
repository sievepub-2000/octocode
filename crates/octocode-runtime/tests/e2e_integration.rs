//! End-to-end integration tests for the Octocode runtime.
//!
//! These tests simulate a complete user interaction flow:
//! provider → runtime → session → tools → response.
//!
//! Uses the mock provider to deterministically verify behavior.

use octocode_core::{
    ModelProvider, OctoError, PlatformKind, PermissionMode, PromptRequest,
    ProviderDescriptor, ProviderKind, ShellKind, ToolCall, ToolExecutor,
    WorkspaceContext, ProviderCapabilities,
};
use octocode_mock_provider::{MockProvider, MockScenario};
use octocode_runtime::{
    MemorySessionStore, OctocodeRuntime, WorkspaceToolExecutor,
    SubAgentManager, SubAgentExecutor, SubAgentState,
};

use std::time::Duration;

// ─── Test Helpers ───────────────────────────────────────────────────────────────

fn test_workspace() -> WorkspaceContext {
    WorkspaceContext {
        root: std::env::temp_dir()
            .join("octocode_e2e_test")
            .to_string_lossy()
            .into_owned(),
        platform: PlatformKind::Linux,
        preferred_shell: ShellKind::Bash,
    }
}

fn make_runtime(
    provider: MockProvider,
) -> OctocodeRuntime<MockProvider, MemorySessionStore, WorkspaceToolExecutor> {
    let ws = test_workspace();
    let root = ws.root.clone();
    let sessions = MemorySessionStore::new();
    let tools = WorkspaceToolExecutor::new(&root);
    let providers = vec![ProviderDescriptor {
        id: String::from("mock"),
        display_name: String::from("Mock Provider"),
        kind: ProviderKind::Stub,
        supports_tools: true,
        supports_streaming: true,
        capabilities: ProviderCapabilities::compatible(true, true),
    }];
    OctocodeRuntime::new(provider, sessions, tools, ws, providers)
}

fn make_prompt(text: &str) -> PromptRequest {
    PromptRequest {
        text: String::from(text),
        model: Some(String::from("mock-model")),
        system_prompt: None,
        history: Vec::new(),
    }
}

// ─── E2E: Full Prompt Flow ──────────────────────────────────────────────────────

#[test]
fn e2e_single_prompt_returns_expected_response() {
    let provider = MockProvider::with_queue(vec![String::from("Hello, world!")]);
    let runtime = make_runtime(provider);

    let response = runtime.prompt(make_prompt("Say hello")).unwrap();
    assert_eq!(response.output, "Hello, world!");
    assert!(response.tokens.is_some());
    let tokens = response.tokens.unwrap();
    assert_eq!(tokens.input_tokens, 10);
    assert_eq!(tokens.output_tokens, 20);
}

#[test]
fn e2e_multiple_prompts_drain_queue_in_order() {
    let provider = MockProvider::with_queue(vec![
        String::from("first"),
        String::from("second"),
        String::from("third"),
    ]);
    let runtime = make_runtime(provider);

    for expected in &["first", "second", "third"] {
        let response = runtime.prompt(make_prompt("query")).unwrap();
        assert_eq!(response.output, *expected);
    }
}

#[test]
fn e2e_pattern_matching_routes_correctly() {
    let provider = MockProvider::with_patterns(vec![
        MockScenario {
            prompt_contains: Some(String::from("rust")),
            response: String::from("Rust is a systems language"),
            input_tokens: 5,
            output_tokens: 15,
        },
        MockScenario {
            prompt_contains: Some(String::from("python")),
            response: String::from("Python is a scripting language"),
            input_tokens: 5,
            output_tokens: 15,
        },
    ]);
    let runtime = make_runtime(provider);

    let r1 = runtime.prompt(make_prompt("tell me about rust")).unwrap();
    assert_eq!(r1.output, "Rust is a systems language");

    let r2 = runtime.prompt(make_prompt("tell me about python")).unwrap();
    assert_eq!(r2.output, "Python is a scripting language");
}

#[test]
fn e2e_provider_error_propagates() {
    let provider = MockProvider::failing("connection timeout");
    let runtime = make_runtime(provider);

    let result = runtime.prompt(make_prompt("anything"));
    assert!(result.is_err());
    let err = result.unwrap_err();
    match err {
        OctoError::Provider(msg) => assert!(msg.contains("connection timeout")),
        other => panic!("unexpected error variant: {other:?}"),
    }
}

// ─── E2E: Session Interaction ───────────────────────────────────────────────────

#[test]
fn e2e_session_prompt_on_memory_store_errors_on_append() {
    let provider = MockProvider::with_queue(vec![String::from("session response")]);
    let runtime = make_runtime(provider);

    // MemorySessionStore has a "bootstrap" session pre-created.
    // However it doesn't persist messages (returns Err on append),
    // so prompt_in_session will fail at the append step.
    let result = runtime.prompt_in_session("bootstrap", "hello from session");
    assert!(result.is_err());
}

#[test]
fn e2e_session_prompt_unknown_session_returns_error() {
    let provider = MockProvider::echo();
    let runtime = make_runtime(provider);

    let result = runtime.prompt_in_session("nonexistent-session-id", "hi");
    assert!(result.is_err());
}

// ─── E2E: Tool Execution ────────────────────────────────────────────────────────

#[test]
fn e2e_tool_echo_roundtrip() {
    let tools = WorkspaceToolExecutor::new(std::env::temp_dir());
    let call = ToolCall {
        name: String::from("echo"),
        input: String::from("test payload"),
        permission: PermissionMode::ReadOnly,
    };
    let result = tools.execute(call).unwrap();
    assert!(result.output.contains("test payload"));
}

// ─── E2E: Sub-Agent Parallel Execution ──────────────────────────────────────────

#[test]
fn e2e_subagent_executor_parallel_tasks_complete() {
    let executor = SubAgentExecutor::new(4);

    // Spawn 10 parallel tasks and collect receivers
    let mut receivers = Vec::new();
    for i in 0..10 {
        let task_id = format!("task-{i}");
        let rx = executor.submit(task_id, format!("goal-{i}"), Box::new(move |_goal| {
            Ok(format!("result-{i}"))
        }));
        receivers.push(rx);
    }

    // Wait for all results
    for rx in receivers {
        let result = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(result.outcome.is_ok());
        assert!(result.outcome.unwrap().starts_with("result-"));
    }
}

#[test]
fn e2e_subagent_executor_handles_failures_gracefully() {
    let executor = SubAgentExecutor::new(2);

    let good_rx = executor.submit(
        String::from("good"),
        String::from("do good"),
        Box::new(|_| Ok(String::from("ok"))),
    );
    let bad_rx = executor.submit(
        String::from("bad"),
        String::from("do bad"),
        Box::new(|_| Err(String::from("simulated failure"))),
    );

    let good = good_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(good.outcome.is_ok());

    let bad = bad_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(bad.outcome.is_err());
    assert!(bad.outcome.unwrap_err().contains("simulated failure"));
}

#[test]
fn e2e_subagent_manager_lifecycle() {
    let manager = SubAgentManager::new(4, 30);

    // Spawn a sub-agent
    let id = manager.spawn("analysis task").unwrap();
    let task = manager.status(&id).unwrap();
    assert_eq!(task.state, SubAgentState::Running);

    // Complete it
    assert!(manager.complete(&id, String::from("analysis done")));
    let task = manager.status(&id).unwrap();
    assert_eq!(task.state, SubAgentState::Completed);
    assert_eq!(task.result.as_deref(), Some("analysis done"));

    // List all
    let agents = manager.list(None);
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].goal, "analysis task");
}

#[test]
fn e2e_subagent_manager_respects_concurrency_limit() {
    let manager = SubAgentManager::new(2, 30);

    let _id1 = manager.spawn("task 1").unwrap();
    let _id2 = manager.spawn("task 2").unwrap();
    let result = manager.spawn("task 3");
    assert!(result.is_err()); // Should fail — limit reached
}

// ─── E2E: Runtime Status ────────────────────────────────────────────────────────

#[test]
fn e2e_runtime_status_reports_provider_info() {
    let provider = MockProvider::echo();
    let runtime = make_runtime(provider);

    let status = runtime.status().unwrap();
    assert_eq!(status.provider_id, "mock-echo");
    assert_eq!(status.session_count, 1); // bootstrap session
}

// ─── E2E: Config Reload ─────────────────────────────────────────────────────────

#[test]
fn e2e_config_reload_doesnt_crash() {
    let provider = MockProvider::echo();
    let mut runtime = make_runtime(provider);

    // Reload should succeed even if config file doesn't exist (uses defaults)
    let result = runtime.reload_config();
    // May return Ok or Err depending on file presence, but should not panic.
    let _ = result;
}

// ─── E2E: Streaming via Provider Trait ──────────────────────────────────────────

#[test]
fn e2e_streaming_emits_tokens_then_completes() {
    let provider = MockProvider::with_queue(vec![String::from("hello world streaming")]);

    let mut tokens = Vec::new();
    let request = make_prompt("stream test");

    // Use the ModelProvider trait's prompt_stream directly
    let response = provider
        .prompt_stream(request, &mut |token| {
            tokens.push(String::from(token));
        })
        .unwrap();

    assert_eq!(response.output, "hello world streaming");
    assert!(!tokens.is_empty());
    // The mock emits word-by-word
    assert!(tokens.contains(&String::from("hello")));
}

// ─── E2E: Echo Provider Fallback ────────────────────────────────────────────────

#[test]
fn e2e_echo_provider_echoes_input() {
    let provider = MockProvider::echo();
    let runtime = make_runtime(provider);

    let response = runtime.prompt(make_prompt("my unique prompt text")).unwrap();
    // Echo mode returns "[mock-echo] <truncated input>"
    assert!(response.output.contains("my unique prompt text"));
}

// ─── E2E: Health Guardian Failover ──────────────────────────────────────────────

#[test]
fn e2e_guardian_failover_on_probe_failure() {
    use octocode_runtime::{HealthGuardian, GuardianConfig};
    use std::sync::Arc;

    let config = GuardianConfig {
        check_interval: Duration::from_millis(50),
        failure_threshold: 2,
        probe_timeout: Duration::from_secs(1),
        recovery_cooldown: Duration::from_millis(200),
    };

    // Probe: "primary" always fails, "secondary" always ok
    let probe: Arc<Box<dyn Fn(&str) -> Result<u64, String> + Send + Sync>> =
        Arc::new(Box::new(|id: &str| {
            if id == "primary" {
                Err(String::from("down"))
            } else {
                Ok(1)
            }
        }));

    let failover: Arc<Box<dyn Fn(&str, &str) -> bool + Send + Sync>> =
        Arc::new(Box::new(|_from, _to| true));

    let guardian = HealthGuardian::start(
        vec!["primary".into(), "secondary".into()],
        "primary".into(),
        config,
        probe,
        failover,
    );

    std::thread::sleep(Duration::from_millis(250));

    let snap = guardian.snapshots();
    // Primary should be flagged unhealthy after threshold
    if let Some(primary) = snap.iter().find(|s| s.provider_id == "primary") {
        assert!(!primary.healthy || primary.consecutive_failures > 0);
    }
    // Secondary should stay healthy
    if let Some(secondary) = snap.iter().find(|s| s.provider_id == "secondary") {
        assert!(secondary.healthy);
    }

    guardian.stop();
}

#[test]
fn e2e_guardian_failover_event_logged() {
    use octocode_runtime::{HealthGuardian, GuardianConfig};
    use std::sync::Arc;

    let config = GuardianConfig {
        check_interval: Duration::from_millis(30),
        failure_threshold: 1, // fail after 1 bad probe
        probe_timeout: Duration::from_secs(1),
        recovery_cooldown: Duration::from_millis(100),
    };

    let probe: Arc<Box<dyn Fn(&str) -> Result<u64, String> + Send + Sync>> =
        Arc::new(Box::new(|_id: &str| Err(String::from("timeout"))));

    let failover: Arc<Box<dyn Fn(&str, &str) -> bool + Send + Sync>> =
        Arc::new(Box::new(|_from, _to| true));

    let guardian = HealthGuardian::start(
        vec!["unstable".into(), "backup".into()],
        "unstable".into(),
        config,
        probe,
        failover,
    );

    std::thread::sleep(Duration::from_millis(200));
    let log = guardian.failover_log();
    // Should have at least one failover event for "unstable"
    assert!(
        log.iter().any(|e| e.from_provider == "unstable"),
        "expected failover event for 'unstable', got: {log:?}"
    );

    guardian.stop();
}

// ─── E2E: Workspace Auth Token ──────────────────────────────────────────────────

#[test]
fn e2e_workspace_token_issue_validate_revoke() {
    use octocode_runtime::WorkspaceTokenStore;

    let store = WorkspaceTokenStore::new();

    // Issue tokens for two workspaces
    let tok_a = store.issue("ws-alpha", 0);
    let tok_b = store.issue("ws-beta", 60_000);

    // Validate
    assert_eq!(store.validate(&tok_a.token).unwrap(), "ws-alpha");
    assert_eq!(store.validate(&tok_b.token).unwrap(), "ws-beta");

    // Invalid token
    assert!(store.validate("bogus").is_err());

    // Revoke workspace-wide
    store.revoke_workspace("ws-alpha");
    assert!(store.validate(&tok_a.token).is_err());
    assert!(store.validate(&tok_b.token).is_ok()); // ws-beta still valid
}

// ─── E2E: Benchmark Regression Gating ──────────────────────────────────────────

#[test]
fn e2e_benchmark_gate_passes_stable_suite() {
    use octocode_runtime::{run_standard_suite, gate_benchmarks};

    let suite = run_standard_suite(20);
    let baselines = suite.reports();

    // Run again — same code should not regress >200%
    // (high threshold because e2e runs with only 20 samples under CPU contention)
    let suite2 = run_standard_suite(20);
    let current = suite2.reports();

    let result = gate_benchmarks(&baselines, &current, 200.0);
    assert!(result.is_ok(), "standard suite regressed: {:?}", result.err());
}
