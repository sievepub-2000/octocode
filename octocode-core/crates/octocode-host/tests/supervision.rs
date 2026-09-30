//! End-to-end supervision: the host drives a scripted stand-in for the harness.
//!
//! This file has its own `main` (`harness = false`). Run by cargo it is the test
//! runner; launched by the host with `FAKE_HARNESS_MODE` set it plays the harness,
//! printing streaming-json lines per attempt and recording what it was given.

use std::path::{Path, PathBuf};
use std::time::Duration;

use octocode_host::agent::{AgentEvent, AgentManager, AgentRun};
use serde_json::{Value, json};

fn main() {
    if let Ok(mode) = std::env::var("FAKE_HARNESS_MODE") {
        fake_harness(&mode);
        return;
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut failures = 0;
    for (name, test) in [
        ("endpoint_failure_resumes_on_the_fallback_model", endpoint_failure_resumes_on_the_fallback_model as fn() -> Scenario),
        ("stream_rule_stops_the_attempt_and_resumes_with_the_correction", stream_rule_stops_the_attempt_and_resumes_with_the_correction),
        ("repeated_call_is_interrupted_once", repeated_call_is_interrupted_once),
        ("non_endpoint_failure_does_not_fall_back", non_endpoint_failure_does_not_fall_back),
        ("spent_budget_observes_without_stopping_the_attempt", spent_budget_observes_without_stopping_the_attempt),
        ("endpoint_failure_without_fallback_is_retried_once_on_the_same_model", endpoint_failure_without_fallback_is_retried_once_on_the_same_model),
        ("resumed_task_receives_plan_reminder", resumed_task_receives_plan_reminder),
        ("cancel_during_endpoint_backoff_does_not_restart", cancel_during_endpoint_backoff_does_not_restart),
        ("malformed_advisor_ends_with_terminal_error", malformed_advisor_ends_with_terminal_error),
    ] {
        let scenario = test();
        match std::panic::catch_unwind(|| runtime.block_on(scenario.run())) {
            Ok(()) => println!("test {name} ... ok"),
            Err(_) => {
                println!("test {name} ... FAILED");
                failures += 1;
            }
        }
    }
    println!("test result: {}. {failures} failed", if failures == 0 { "ok" } else { "FAILED" });
    if failures > 0 {
        std::process::exit(1);
    }
}

fn fake_harness(mode: &str) {
    let home = PathBuf::from(std::env::var("OCTOCODE_HOME").unwrap());
    let counter = home.join("attempts");
    let attempt = std::fs::read_to_string(&counter).ok().and_then(|n| n.trim().parse::<u32>().ok()).unwrap_or(0) + 1;
    std::fs::write(&counter, attempt.to_string()).unwrap();
    let args: Vec<String> = std::env::args().collect();
    let prompt_file = args.iter().position(|a| a == "--prompt-file").map(|i| PathBuf::from(&args[i + 1])).unwrap();
    let prompt = std::fs::read_to_string(prompt_file).unwrap();
    let config = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let model = config.lines().find(|l| l.starts_with("model = ")).unwrap_or("").to_owned();
    let resumed = args.iter().any(|a| a == "--resume");
    std::fs::write(home.join(format!("attempt-{attempt}.json")), json!({"prompt": prompt, "model": model, "resumed": resumed}).to_string()).unwrap();
    let emit = |line: Value| println!("{line}");
    match (mode, attempt) {
        ("fallback", 1) => {
            emit(json!({"type": "error", "message": "The model endpoint is temporarily unavailable (HTTP 502)."}));
            std::process::exit(1);
        }
        ("endpoint-twice" | "cancel-backoff", 1 | 2) => {
            emit(json!({"type": "error", "message": "error sending request for url (http://127.0.0.1:9/v1/chat/completions)"}));
            std::process::exit(1);
        }
        ("other-failure", 1) => {
            emit(json!({"type": "error", "message": "Tool permission denied."}));
            std::process::exit(1);
        }
        ("rule", 1) => {
            emit(json!({"type": "text", "data": "抱歉，我无法访问互联网，"}));
            std::thread::sleep(Duration::from_secs(20));
        }
        ("rule-no-budget", 1) => {
            emit(json!({"type": "text", "data": "抱歉，我无法访问互联网。"}));
            std::thread::sleep(Duration::from_secs(2));
            emit(json!({"type": "end", "stopReason": "end_turn"}));
        }
        ("stall", 1) => {
            for _ in 0..3 {
                emit(json!({"type": "tool_call", "toolName": "read_file", "rawInput": {"path": "same.txt"}}));
            }
            std::thread::sleep(Duration::from_secs(20));
        }
        _ => {
            emit(json!({"type": "text", "data": "Finished."}));
            emit(json!({"type": "end", "stopReason": "end_turn"}));
        }
    }
}

struct Scenario {
    mode: &'static str,
    fallbacks: Vec<Value>,
    max_interventions: u32,
    check: fn(&Path, &[AgentEvent]),
}

impl Scenario {
    async fn run(self) {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        // Safety: the runner is single-threaded between scenarios; children inherit this.
        unsafe { std::env::set_var("FAKE_HARNESS_MODE", self.mode) };
        let mut input = json!({
            "task_id": format!("task-{}", self.mode), "session_id": format!("session-{}", self.mode),
            "executable": std::env::current_exe().unwrap(), "harness_home": home.path(), "cwd": cwd.path(),
            "prompt": "do the task",
            "resume": self.mode == "plan-resume",
            "model": model("primary"),
            "supervision": {"fallbacks": self.fallbacks, "max_interventions": self.max_interventions, "endpoint_retry_secs": if self.mode == "cancel-backoff" { 30 } else { 0 }},
        });
        if self.mode == "malformed-advisor" {
            let mut advisor_model = model("judge");
            advisor_model["extra_body"] = json!({"chat_template_kwargs":"malformed fixture"});
            input["supervision"]["advisor"] = json!({"model":advisor_model, "min_tool_calls":0});
        }
        let run: AgentRun = serde_json::from_value(input).unwrap();
        let (events_tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let manager = AgentManager::default();
        let task_id = manager.start(run, events_tx).unwrap();
        let mut seen = Vec::new();
        let finished = tokio::time::timeout(Duration::from_secs(if self.mode == "cancel-backoff" { 5 } else { 60 }), async {
            while let Some(event) = events.recv().await {
                if self.mode == "cancel-backoff" && event.kind == "error" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    assert!(manager.cancel(&task_id));
                }
                let done = event.kind == "agent.finished" || event.kind == "agent.error";
                seen.push(event);
                if done {
                    break;
                }
            }
        })
        .await;
        unsafe { std::env::remove_var("FAKE_HARNESS_MODE") };
        assert!(finished.is_ok(), "task never finished: {:?}", seen.iter().map(|e| &e.kind).collect::<Vec<_>>());
        (self.check)(home.path(), &seen);
    }
}

fn model(name: &str) -> Value {
    json!({"model": name, "base_url": "http://127.0.0.1:9/v1", "api_key": "k", "api_backend": "chat_completions",
        "context_window": 65536, "max_completion_tokens": 1000})
}

fn malformed_advisor_ends_with_terminal_error() -> Scenario {
    Scenario {
        mode: "malformed-advisor", fallbacks: vec![], max_interventions: 3,
        check: |home, events| {
            assert_eq!(events.last().map(|event| event.kind.as_str()), Some("agent.error"));
            assert!(events.last().unwrap().payload["message"].as_str().unwrap().contains("chat_template_kwargs"));
            assert!(!home.join("attempt-1.json").exists(), "invalid advisor must be rejected before a harness starts");
        },
    }
}

fn cancel_during_endpoint_backoff_does_not_restart() -> Scenario {
    Scenario {
        mode: "cancel-backoff", fallbacks: vec![], max_interventions: 3,
        check: |home, events| {
            assert_eq!(finished(events)["cancelled"], true);
            assert_eq!(finished(events)["attempts"], 1);
            assert!(!home.join("attempt-2.json").exists());
        },
    }
}

fn resumed_task_receives_plan_reminder() -> Scenario {
    Scenario {
        mode: "plan-resume",
        fallbacks: vec![],
        max_interventions: 0,
        check: |home, events| {
            let first = attempt(home, 1);
            assert_eq!(first["resumed"], true);
            let blocks: Value = serde_json::from_str(first["prompt"].as_str().unwrap()).unwrap();
            assert_eq!(blocks[0], json!({"type":"text", "text":"do the task"}));
            assert_eq!(blocks.as_array().unwrap().len(), 2);
            assert!(blocks[1]["text"].as_str().unwrap().contains("merge=false"));
            assert_eq!(finished(events)["success"], true);
        },
    }
}

fn attempt(home: &Path, n: u32) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.join(format!("attempt-{n}.json"))).unwrap()).unwrap()
}

fn supervisor_actions(events: &[AgentEvent]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e.kind == "agent.supervisor")
        .filter_map(|e| e.payload["action"].as_str().map(str::to_owned))
        .filter(|action| action != "attempt_started")
        .collect()
}

fn finished(events: &[AgentEvent]) -> &Value {
    &events.last().unwrap().payload
}

fn endpoint_failure_resumes_on_the_fallback_model() -> Scenario {
    Scenario {
        mode: "fallback",
        fallbacks: vec![model("backup")],
        max_interventions: 3,
        check: |home, events| {
            assert_eq!(supervisor_actions(events), ["fallback"]);
            assert!(attempt(home, 1)["model"].as_str().unwrap().contains("primary"));
            let second = attempt(home, 2);
            assert!(second["model"].as_str().unwrap().contains("backup"));
            assert_eq!(second["resumed"], true);
            assert!(second["prompt"].as_str().unwrap().contains("different model"));
            assert_eq!(finished(events)["success"], true);
            assert_eq!(finished(events)["attempts"], 2);
            assert_eq!(events.iter().filter(|e| e.kind == "agent.started").count(), 1);
        },
    }
}

fn stream_rule_stops_the_attempt_and_resumes_with_the_correction() -> Scenario {
    Scenario {
        mode: "rule",
        fallbacks: vec![],
        max_interventions: 3,
        check: |home, events| {
            assert_eq!(supervisor_actions(events), ["rule"]);
            let second = attempt(home, 2);
            assert_eq!(second["resumed"], true);
            assert!(second["prompt"].as_str().unwrap().contains("web_fetch"));
            assert_eq!(finished(events)["success"], true);
            assert_eq!(finished(events)["interventions"], 1);
        },
    }
}

fn repeated_call_is_interrupted_once() -> Scenario {
    Scenario {
        mode: "stall",
        fallbacks: vec![],
        max_interventions: 3,
        check: |home, events| {
            assert_eq!(supervisor_actions(events), ["stall"]);
            assert!(attempt(home, 2)["prompt"].as_str().unwrap().contains("same call three times"));
            assert_eq!(finished(events)["success"], true);
        },
    }
}

fn non_endpoint_failure_does_not_fall_back() -> Scenario {
    Scenario {
        mode: "other-failure",
        fallbacks: vec![model("backup")],
        max_interventions: 3,
        check: |home, events| {
            assert!(supervisor_actions(events).is_empty());
            assert!(!home.join("attempt-2.json").exists());
            assert_eq!(finished(events)["success"], false);
            assert_eq!(finished(events)["attempts"], 1);
        },
    }
}

fn spent_budget_observes_without_stopping_the_attempt() -> Scenario {
    Scenario {
        mode: "rule-no-budget",
        fallbacks: vec![],
        max_interventions: 0,
        check: |home, events| {
            assert!(supervisor_actions(events).is_empty());
            assert!(!home.join("attempt-2.json").exists(), "the attempt must not be killed and resumed");
            assert_eq!(finished(events)["success"], true);
            assert_eq!(finished(events)["attempts"], 1);
        },
    }
}

fn endpoint_failure_without_fallback_is_retried_once_on_the_same_model() -> Scenario {
    Scenario {
        mode: "endpoint-twice",
        fallbacks: vec![],
        max_interventions: 3,
        check: |home, events| {
            assert_eq!(supervisor_actions(events), ["endpoint_retry"]);
            let second = attempt(home, 2);
            assert!(second["model"].as_str().unwrap().contains("primary"));
            assert_eq!(second["resumed"], true);
            assert!(!home.join("attempt-3.json").exists(), "retried once only");
            assert_eq!(finished(events)["success"], false);
        },
    }
}
