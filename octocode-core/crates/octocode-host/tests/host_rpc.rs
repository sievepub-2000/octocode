use octocode_host::{host::Host, protocol::Request};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn call(host: &Host, method: &str, params: serde_json::Value) -> serde_json::Value {
    let response = host.dispatch(Request {
        id: json!(1),
        method: method.into(),
        params,
    });
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

fn error(host: &Host, method: &str, params: serde_json::Value) -> String {
    host.dispatch(Request {
        id: json!(1),
        method: method.into(),
        params,
    })
    .error
    .expect("request must fail")
    .message
}

#[test]
fn legacy_import_is_atomic_idempotent_and_cannot_restart_the_old_engine() {
    let host = Host::open(":memory:").unwrap();
    let input = json!({"id":"imported","title":"old task","workspace":".","created_at":1,"updated_at":2,"source_key":"old/task","source_hash":"a".repeat(64),"messages":[{"role":"user","content":"preserve objective","created_at":1},{"role":"assistant","content":"answer","created_at":2}],"events":[{"kind":"legacy.turn","payload":{"task_id":"imported-turn-0","user_index":0}},{"kind":"text","payload":{"text":"answer"}},{"kind":"legacy.record","payload":{"type":"say","say":"text","text":"answer"}}]});
    assert_eq!(call(&host,"session.import_legacy",input.clone())["imported"],true);
    assert_eq!(call(&host,"session.import_legacy",input.clone())["imported"],false);
    assert_eq!(call(&host,"message.list",json!({"session_id":"imported"})).as_array().unwrap().len(),2);
    let mut changed = input.clone(); changed["source_hash"]=json!("b".repeat(64));
    assert!(error(&host,"session.import_legacy",changed).contains("source changed"));
    let mut invalid = input.clone(); invalid["id"]=json!("invalid"); invalid["source_key"]=json!("old/invalid"); invalid["events"][0]["kind"]=json!("harness.prepared");
    assert!(error(&host,"session.import_legacy",invalid).contains("invalid legacy event"));
    assert!(call(&host,"session.get",json!({"id":"invalid"})).is_null());
    assert!(error(&host,"harness.continue",json!({"session_id":"imported","prompt":"continue","provider":{}})).contains("新对话接续"));
    assert_eq!(call(&host,"session.get",json!({"id":"imported"}))["status"],"stopped");
}

#[test]
fn history_presentation_omits_unused_payloads_without_changing_audit_events() {
    let host = Host::open(":memory:").unwrap();
    call(&host, "session.create", json!({"id":"history","title":"History test","workspace":"."}));
    for kind in ["thought", "tool_call_update", "available_commands", "text"] {
        call(&host, "event.append", json!({"session_id":"history", "kind":kind, "payload":{"data":"preserved"}}));
    }
    let raw = call(&host, "event.list", json!({"session_id":"history"}));
    let view = call(&host, "event.list", json!({"session_id":"history", "presentation":true}));
    assert_eq!(view[0], raw[0]);
    assert_eq!(view[3], raw[3]);
    assert_eq!(view[1][0], raw[1][0]);
    assert_eq!(view[1][1], raw[1][1]);
    assert!(view[1][2].is_null());
    assert!(view[2][2].is_null());
    assert_eq!(call(&host, "event.list", json!({"session_id":"history"})), raw);
}

#[test]
fn bounded_history_preserves_turns_cursors_and_raw_audit() {
    let host = Host::open(":memory:").unwrap();
    for id in ["paged", "other"] {
        call(&host, "session.create", json!({"id":id,"title":id,"workspace":"."}));
    }
    for turn in 0..5 {
        call(&host, "event.append", json!({"session_id":"paged","kind":if turn==0 {"harness.prepared"} else {"harness.continued"},"payload":{"task_id":turn}}));
        for _ in 0..3 {
            call(&host, "event.append", json!({"session_id":"paged","kind":"thought","payload":{"type":"thought","data":"x"}}));
            call(&host, "event.append", json!({"session_id":"other","kind":"text","payload":{"data":"must not leak"}}));
        }
    }
    let start = call(&host, "event.history_start", json!({"session_id":"paged","turns":3}));
    assert_eq!(start["skipped_turns"], 2);
    let mut after = start["after"].as_i64().unwrap();
    let mut rows = Vec::new();
    loop {
        let page = call(&host, "event.page", json!({"session_id":"paged","after":after,"limit":2}));
        assert!(page["rows"].as_array().unwrap().len() <= 2);
        assert!(page["next"].as_i64().unwrap() >= after);
        after = page["next"].as_i64().unwrap();
        rows.extend(page["rows"].as_array().unwrap().clone());
        if page["has_more"] == false { break; }
    }
    assert_eq!(rows.len(),12);
    assert_eq!(rows[0][1],"harness.continued");
    let view = call(&host, "event.page", json!({"session_id":"paged","limit":4,"presentation":true}));
    assert_eq!(view["rows"].as_array().unwrap().len(),2);
    assert_eq!(view["rows"][1][2]["data"],"xxx");
    assert_eq!(call(&host,"event.list",json!({"session_id":"paged"})).as_array().unwrap().len(),20);
    assert!(error(&host,"event.page",json!({"session_id":"paged","limit":0})).contains("page size"));
    assert!(error(&host,"event.page",json!({"session_id":"paged","after":-1})).contains("cursor"));
}

fn git(cwd: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn worktree_rpc_is_the_single_durable_git_authority() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init"]);
    git(
        &repo,
        &["config", "user.email", "octocode@example.invalid"],
    );
    git(&repo, &["config", "user.name", "OctoCode Test"]);
    std::fs::write(repo.join("README.md"), "test\n").unwrap();
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-m", "initial"]);

    let host = Host::open(temp.path().join("octocode.db")).unwrap();
    let target = temp.path().join("task");
    assert_eq!(
        call(&host, "worktree.status", json!({"cwd":repo}))["isGitRepo"],
        true
    );
    assert_eq!(
        call(
            &host,
            "worktree.create",
            json!({
                "cwd":repo,
                "path":target,
                "branch":"worktree/rpc-test",
                "baseBranch":"HEAD",
                "createNewBranch":true
            }),
        )["success"],
        true
    );
    assert_eq!(
        call(&host, "worktree.list", json!({"cwd":repo}))[1]["branch"],
        "worktree/rpc-test"
    );

    // A new Host process must read the same registered worktree from Git.
    drop(host);
    let restarted = Host::open(temp.path().join("octocode.db")).unwrap();
    assert_eq!(
        call(&restarted, "worktree.list", json!({"cwd":repo}))[1]["branch"],
        "worktree/rpc-test"
    );
    assert_eq!(
        call(
            &restarted,
            "worktree.delete",
            json!({"cwd":repo,"path":target,"force":false}),
        )["success"],
        true
    );
    assert_eq!(
        call(&restarted, "worktree.list", json!({"cwd":repo}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn rpc_crud_and_health_are_read_back_from_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::open(dir.path().join("octocode.db")).unwrap();
    let health = call(&host, "health", json!({}));
    assert_eq!(health["ok"], true);
    assert!(health.get("vector").is_none());
    let route = call(
        &host,
        "provider.resolve",
        json!({
            "apiProvider":"openai-native",
            "apiModelId":"qwen3.8-27b",
            "openAiNativeBaseUrl":"http://192.168.10.2:8000/v1"
        }),
    );
    assert_eq!(route["model"]["api_backend"], "chat_completions");

    let session = call(&host, "session.create", json!({"title":"RPC task"}));
    let session_id = session["id"].as_str().unwrap();
    assert!(host.set_session_status(session_id, "running").unwrap());
    assert_eq!(
        call(&host, "session.get", json!({"id":session_id}))["status"],
        "running"
    );
    let message = call(
        &host,
        "message.append",
        json!({
            "session_id": session_id, "role":"user", "content":"hello"
        }),
    );
    let message_id = message["id"].as_str().unwrap();
    assert_eq!(
        call(&host, "message.list", json!({"session_id":session_id}))[0]["content"],
        "hello"
    );
    assert_eq!(
        call(
            &host,
            "message.update",
            json!({"id":message_id,"content":"updated"})
        )["updated"],
        true
    );
    assert_eq!(
        call(&host, "message.delete", json!({"id":message_id}))["deleted"],
        true
    );
    assert_eq!(
        {
            assert!(error(&host,"session.delete",json!({"id":session_id})).contains("停止"));
            host.set_session_status(session_id,"completed").unwrap();
            call(&host, "session.delete", json!({"id":session_id}))["deleted"].clone()
        },
        true
    );
    assert!(
        call(&host, "session.list", json!({}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn rpc_reports_invalid_params_and_unknown_methods() {
    let host = Host::open(":memory:").unwrap();
    let invalid = host.dispatch(Request {
        id: json!(1),
        method: "session.create".into(),
        params: json!({}),
    });
    assert_eq!(invalid.error.unwrap().code, -32602);
    let missing = host.dispatch(Request {
        id: json!(2),
        method: "missing".into(),
        params: json!({}),
    });
    assert_eq!(missing.error.unwrap().code, -32601);
}

#[test]
fn operational_logs_are_queryable_with_rpc_correlation() {
    let host = Host::open(":memory:").unwrap();
    call(
        &host,
        "log.create",
        json!({
            "category":"system",
            "level":"warn",
            "subsystem":"knowledge",
            "message":"crawl retried",
            "fields":{"source_id":"source-1"}
        }),
    );
    let request = Request {
        id: json!(42),
        method: "health".into(),
        params: json!({"task_id":"task-1"}),
    };
    let response = host.dispatch(request.clone());
    host.record_rpc(&request.method, &request.params, &response, 7);
    let logs = call(
        &host,
        "log.list",
        json!({"category":"developer","limit":10}),
    );
    assert!(logs.as_array().unwrap().iter().any(|log| {
        log["subsystem"] == "rpc"
            && log["fields"]["request_id"] == 42
            && log["fields"]["task_id"] == "task-1"
    }));
    let system = call(&host, "log.list", json!({"category":"system","limit":10}));
    assert!(system.as_array().unwrap().iter().any(|log| {
        log["subsystem"] == "knowledge" && log["fields"]["source_id"] == "source-1"
    }));
}

#[test]
fn logs_are_filtered_by_keyword_and_date_range() {
    let host = Host::open(":memory:").unwrap();
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"info","subsystem":"browser","message":"opened alpha page"}),
    );
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"warn","subsystem":"terminal","message":"beta command retried"}),
    );
    let future = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 10_000;

    let keyword = call(
        &host,
        "log.list",
        json!({"category":"system","keyword":"alpha","limit":10}),
    );
    assert_eq!(keyword.as_array().unwrap().len(), 1);
    assert_eq!(keyword[0]["subsystem"], "browser");
    assert!(
        call(
            &host,
            "log.list",
            json!({"category":"system","from":future,"limit":10})
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    let dated = call(
        &host,
        "log.list",
        json!({"category":"system","from":0,"to":future,"limit":10}),
    );
    assert!(
        dated
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["message"] == "opened alpha page")
    );
    assert!(
        dated
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["message"] == "beta command retried")
    );
}

#[test]
fn logs_can_be_tailed_without_replaying_old_records() {
    let host = Host::open(":memory:").unwrap();
    let first = call(
        &host,
        "log.create",
        json!({"category":"system","level":"info","subsystem":"runtime","message":"first"}),
    )["id"]
        .as_i64()
        .unwrap();
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"warn","subsystem":"runtime","message":"second"}),
    );

    let logs = call(
        &host,
        "log.list",
        json!({"category":"system","after_id":first,"limit":10}),
    );
    assert_eq!(logs.as_array().unwrap().len(), 1);
    assert_eq!(logs[0]["message"], "second");
}

#[test]
fn matching_logs_can_be_deleted_without_touching_other_records() {
    let host = Host::open(":memory:").unwrap();
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"info","subsystem":"browser","message":"alpha"}),
    );
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"info","subsystem":"terminal","message":"beta"}),
    );

    assert_eq!(
        call(
            &host,
            "log.delete_matching",
            json!({"category":"system","keyword":"alpha"})
        )["deleted"],
        1
    );
    let remaining = call(&host, "log.list", json!({"category":"system","limit":10}));
    assert!(
        remaining
            .as_array()
            .unwrap()
            .iter()
            .all(|log| log["message"] != "alpha")
    );
    assert!(
        remaining
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["message"] == "beta")
    );
}

#[test]
fn deleting_matching_logs_requires_at_least_one_filter() {
    let host = Host::open(":memory:").unwrap();
    let response = host.dispatch(Request {
        id: json!(1),
        method: "log.delete_matching".into(),
        params: json!({"category":"system"}),
    });

    assert_eq!(response.error.unwrap().code, -32602);
    assert!(
        !call(&host, "log.list", json!({"category":"system","limit":10}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn all_logs_can_be_cleared_in_one_request() {
    let host = Host::open(":memory:").unwrap();
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"info","subsystem":"browser","message":"alpha"}),
    );
    call(
        &host,
        "log.create",
        json!({"category":"system","level":"info","subsystem":"terminal","message":"beta"}),
    );

    assert!(
        call(&host, "log.clear", json!({"category":"system"}))["deleted"]
            .as_i64()
            .unwrap()
            >= 2
    );
    assert!(
        call(&host, "log.list", json!({"category":"system","limit":10}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn system_and_developer_logs_are_strictly_isolated() {
    let host = Host::open(":memory:").unwrap();
    call(
        &host,
        "log.create",
        json!({
            "category":"system",
            "level":"warn",
            "subsystem":"provider",
            "message":"provider connection retried"
        }),
    );
    call(
        &host,
        "log.create",
        json!({
            "category":"developer",
            "level":"debug",
            "subsystem":"rpc",
            "message":"provider request completed"
        }),
    );

    let system = call(
        &host,
        "log.list",
        json!({"category":"system","keyword":"provider","limit":10}),
    );
    assert!(
        system
            .as_array()
            .unwrap()
            .iter()
            .all(|log| log["category"] == "system")
    );
    assert!(
        system
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["message"] == "provider connection retried")
    );

    assert_eq!(
        call(
            &host,
            "log.delete_matching",
            json!({"category":"system","keyword":"provider"}),
        )["deleted"],
        1
    );
    assert_eq!(
        call(&host, "log.clear", json!({"category":"system"}))["deleted"],
        1
    );
    let developer = call(
        &host,
        "log.list",
        json!({"category":"developer","limit":10}),
    );
    assert_eq!(developer.as_array().unwrap().len(), 1);
    assert_eq!(developer[0]["message"], "provider request completed");
}

#[test]
fn log_rpc_rejects_missing_or_unknown_categories() {
    let host = Host::open(":memory:").unwrap();
    for (method, params) in [
        ("log.list", json!({"limit":10})),
        (
            "log.create",
            json!({"category":"other","level":"info","subsystem":"host","message":"bad"}),
        ),
        ("log.clear", json!({"category":"other"})),
    ] {
        let response = host.dispatch(Request {
            id: json!(1),
            method: method.into(),
            params,
        });
        assert_eq!(response.error.unwrap().code, -32602, "{method}");
    }
}

#[test]
fn startup_is_system_and_rpc_traces_are_developer_logs() {
    let host = Host::open(":memory:").unwrap();
    let request = Request {
        id: json!(42),
        method: "health".into(),
        params: json!({}),
    };
    let response = host.dispatch(request.clone());
    host.record_rpc(&request.method, &request.params, &response, 3);

    let system = call(&host, "log.list", json!({"category":"system","limit":10}));
    assert!(
        system
            .as_array()
            .unwrap()
            .iter()
            .all(|log| log["category"] == "system")
    );
    assert!(
        system
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["message"] == "OctoCode host started")
    );
    let developer = call(
        &host,
        "log.list",
        json!({"category":"developer","limit":10}),
    );
    assert!(
        developer
            .as_array()
            .unwrap()
            .iter()
            .all(|log| log["category"] == "developer")
    );
    assert!(
        developer
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["subsystem"] == "rpc")
    );
}

#[test]
fn octocode_harness_owns_routing_identity_and_lifecycle() {
    let host = Host::open(":memory:").unwrap();
    let prepared = call(
        &host,
        "harness.prepare",
        json!({
            "title":"Unified task",
            "workspace":"C:\\workspace",
            "prompt":"inspect the project",
            "provider":{
                "apiProvider":"openai-native",
                "apiModelId":"qwen3.8-27b",
                "openAiNativeBaseUrl":"http://192.168.10.2:8000/v1"
            }
        }),
    );
    let session_id = prepared["session_id"].as_str().unwrap();
    assert_eq!(prepared["route"]["model"]["model"], "qwen3.8-27b");
    assert_eq!(call(&host, "session.get", json!({"id":session_id}))["model"], "qwen3.8-27b");
    assert!(!prepared["task_id"].as_str().unwrap().is_empty());
    assert_eq!(
        call(
            &host,
            "supervisor.resume",
            json!({"id":prepared["task_id"]})
        )["phase"],
        "plan"
    );
    assert_eq!(
        call(&host, "session.get", json!({"id":session_id}))["status"],
        "prepared"
    );
    assert_eq!(
        call(&host, "message.list", json!({"session_id":session_id}))[0]["content"],
        "inspect the project"
    );

    let continued = call(
        &host,
        "harness.continue",
        json!({
            "session_id":session_id,
            "prompt":"now run the tests",
            "provider":{
                "apiProvider":"openai-native",
                "apiModelId":"next-model",
                "openAiNativeBaseUrl":"http://192.168.10.2:8000/v1"
            }
        }),
    );
    assert_ne!(continued["task_id"], prepared["task_id"]);
    assert_eq!(call(&host, "session.get", json!({"id":session_id}))["model"], "next-model");
    let audit = call(&host, "event.list", json!({"session_id":session_id}));
    assert_eq!(audit[0][2]["model"], "qwen3.8-27b");
    assert_eq!(audit[1][2]["model"], "next-model");
    assert_eq!(
        call(&host, "message.list", json!({"session_id":session_id}))[1]["content"],
        "now run the tests"
    );

    call(
        &host,
        "harness.transition",
        json!({"session_id":session_id,"task_id":prepared["task_id"],"state":"running"}),
    );
    call(
        &host,
        "harness.transition",
        json!({"session_id":session_id,"task_id":prepared["task_id"],"state":"completed"}),
    );
    assert_eq!(
        call(&host, "session.get", json!({"id":session_id}))["status"],
        "completed"
    );
    assert_eq!(
        call(&host, "event.list", json!({"session_id":session_id}))
            .as_array()
            .unwrap()
            .len(),
        4
    );

    let invalid = host.dispatch(Request {
        id: json!(2),
        method: "harness.transition".into(),
        params: json!({"session_id":session_id,"task_id":"task","state":"made-up"}),
    });
    assert_eq!(invalid.error.unwrap().code, -32602);
}

#[test]
fn handoff_creates_a_new_session_with_the_last_three_turns() {
    let host = Host::open(":memory:").unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let provider = json!({"apiProvider":"openai-native","apiModelId":"qwen3.8-27b","openAiNativeBaseUrl":"http://127.0.0.1:8000/v1"});
    let first = call(&host, "harness.prepare", json!({"session_id":"source","title":"Original goal","workspace":workspace.path(),"prompt":"goal-0","provider":provider}));
    assert!(error(&host,"harness.handoff",json!({"source_session_id":"source","provider":provider})).contains("Stop"));
    call(&host,"setting.set",json!({"key":"message-queue:source","value":[{"id":"queue-1","text":"pending instruction"}]}));
    for turn in 0..5 {
        if turn > 0 { call(&host,"harness.continue",json!({"session_id":"source","prompt":format!("user-{turn}"),"provider":provider,"images":["data:image/png;base64,YWJj"]})); }
        call(&host,"event.append",json!({"session_id":"source","kind":"text","payload":{"data":format!("answer-{turn}")}}));
        call(&host,"event.append",json!({"session_id":"source","kind":"curator.text","payload":{"data":"must-not-transfer"}}));
    }
    call(&host,"harness.transition",json!({"session_id":"source","task_id":first["task_id"],"state":"completed"}));
    let before=call(&host,"message.list",json!({"session_id":"source"}));
    let moved=call(&host,"harness.handoff",json!({"source_session_id":"source","provider":provider}));
    assert!(error(&host,"harness.handoff",json!({"source_session_id":"source","provider":provider})).contains("already has a new session"));
    assert_ne!(moved["session_id"],"source");
    assert_ne!(moved["task_id"],first["task_id"]);
    assert_eq!(moved["handoff"]["objective"],"goal-0");
    assert_eq!(moved["handoff"]["latest_request"],"user-4");
    assert!(moved["prompt"].as_str().unwrap().ends_with("user-4"));
    assert!(moved["handoff"].get("memory").is_none(), "memory travels with the harness, not the handoff");
    assert_eq!(moved["handoff"]["turns"].as_array().unwrap().len(),3);
    assert_eq!(moved["handoff"]["turns"][0]["user"],"user-2");
    assert_eq!(moved["handoff"]["turns"][2]["assistant"],"answer-4");
    assert_eq!(moved["images"],json!(["data:image/png;base64,YWJj"]));
    assert!(!moved["prompt"].as_str().unwrap().contains("base64"));
    assert!(!moved["prompt"].as_str().unwrap().contains("must-not-transfer"));
    assert_eq!(call(&host,"message.list",json!({"session_id":"source"})),before);
    assert!(call(&host,"setting.get",json!({"key":"message-queue:source"})).is_null());
    let destination=moved["session_id"].as_str().unwrap();
    assert_eq!(call(&host,"setting.get",json!({"key":format!("message-queue:{destination}")}))[0]["id"],"queue-1");
    call(&host,"harness.transition",json!({"session_id":destination,"task_id":moved["task_id"],"state":"completed"}));
    let again=call(&host,"harness.handoff",json!({"source_session_id":destination,"provider":provider}));
    assert_eq!(again["handoff"]["objective"],"goal-0");
    assert_eq!(again["handoff"]["latest_request"],"user-4");
    assert!(again["handoff"].get("memory").is_none());
    assert_eq!(moved["project"]["id"], again["project"]["id"]);
    let sessions = call(&host,"session.list",json!({}));
    assert!(sessions.as_array().unwrap().iter().all(|s| s["project_id"] == moved["project"]["id"]));
}

#[test]
fn legacy_handoff_uses_latest_inherited_turn_when_request_field_is_missing() {
    let host = Host::open(":memory:").unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let provider = json!({"apiProvider":"openai-native","apiModelId":"qwen3.8-flash-next"});
    call(&host,"session.create",json!({"id":"legacy-handoff","title":"Continue","workspace":workspace.path()}));
    call(&host,"message.append",json!({"id":"legacy-message","session_id":"legacy-handoff","role":"user","content":"继续旧任务"}));
    call(&host,"event.append",json!({"session_id":"legacy-handoff","kind":"harness.prepared","payload":{"handoff":{"objective":"Old goal","turns":[{"user":"Do not write files; explain the result","assistant":""}]}}}));
    let result = call(&host,"harness.handoff",json!({"source_session_id":"legacy-handoff","provider":provider}));
    assert_eq!(result["handoff"]["latest_request"], "Do not write files; explain the result");
    assert!(result["prompt"].as_str().unwrap().ends_with("Do not write files; explain the result"));
}

#[test]
fn failed_project_creation_during_handoff_restores_the_source_queue() {
    let host = Host::open(":memory:").unwrap();
    let provider = json!({"apiProvider":"openai-native","apiModelId":"qwen3.8-27b","openAiNativeBaseUrl":"http://127.0.0.1:8000/v1"});
    let first = call(&host,"harness.prepare",json!({"session_id":"source","title":"Goal","prompt":"continue this","provider":provider}));
    call(&host,"harness.transition",json!({"session_id":"source","task_id":first["task_id"],"state":"completed"}));
    let queue = json!([{"id":"q","text":"pending"}]);
    call(&host,"setting.set",json!({"key":"message-queue:source","value":queue}));
    assert!(error(&host,"harness.handoff",json!({"source_session_id":"source","provider":provider})).contains("工作区"));
    assert_eq!(call(&host,"session.list",json!({})).as_array().unwrap().len(),1);
    assert_eq!(call(&host,"setting.get",json!({"key":"message-queue:source"})),queue);
}

#[test]
fn supervisor_checkpoint_blocks_at_retry_ceiling_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("octocode.db");
    let workflow_id = {
        let host = Host::open(&database).unwrap();
        let session = call(&host, "session.create", json!({"title":"Long task"}));
        let result = call(
            &host,
            "supervisor.checkpoint",
            json!({
                "session_id":session["id"],
                "objective":"finish with evidence",
                "phase":"verify",
                "attempt":2,
                "max_attempts":2,
                "verdict":"reject",
                "evidence":["tests failed"],
                "pending":["fix tests"]
            }),
        );
        assert_eq!(result["status"], "blocked");
        result["id"].as_str().unwrap().to_owned()
    };

    let host = Host::open(&database).unwrap();
    let resumed = call(&host, "supervisor.resume", json!({"id":workflow_id}));
    assert_eq!(resumed["phase"], "verify");
    assert_eq!(resumed["state"]["pending"][0], "fix tests");
    assert_eq!(resumed["state"]["verdict"], "reject");
    assert_eq!(
        call(&host, "supervisor.delete", json!({"id":workflow_id}))["deleted"],
        true
    );
    assert!(call(&host, "supervisor.resume", json!({"id":workflow_id})).is_null());
}

#[test]
fn completion_requires_a_persisted_supervisor_acceptance() {
    let host = Host::open(":memory:").unwrap();
    let prepared = call(
        &host,
        "harness.prepare",
        json!({
            "title":"Reviewed task",
            "prompt":"finish safely",
            "provider":{"apiProvider":"openai-native","apiModelId":"qwen3.8-27b","openAiNativeBaseUrl":"http://192.168.10.2:8000/v1"}
        }),
    );
    let task_id = prepared["task_id"].as_str().unwrap();
    let session_id = prepared["session_id"].as_str().unwrap();
    assert_eq!(
        host.record_agent_lifecycle(
            task_id,
            session_id,
            "agent.finished",
            &json!({"success":true})
        )
        .unwrap(),
        "needs_review"
    );
    call(
        &host,
        "supervisor.checkpoint",
        json!({
            "id":task_id,"phase":"pre_completion","attempt":1,"max_attempts":2,
            "verdict":"accept","evidence":["tests pass"],"pending":[]
        }),
    );
    assert_eq!(
        host.record_agent_lifecycle(
            task_id,
            session_id,
            "agent.finished",
            &json!({"success":true})
        )
        .unwrap(),
        "completed"
    );
}

#[test]
fn capabilities_list_is_the_complete_runtime_interface_registry() {
    let host = Host::open(":memory:").unwrap();
    let capabilities = call(&host, "capabilities.list", json!({}));
    let methods = capabilities["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    for method in [
        "agent.run",
        "worktree.delete",
        "log.list",
        "log.clear",
        "setting.set",
    ] {
        assert!(methods.contains(method), "missing {method}");
    }
    assert_eq!(
        methods.len(),
        capabilities["methods"].as_array().unwrap().len()
    );
    assert_eq!(capabilities["protocol_version"], 1);
    // Memory belongs to the harness; the Host no longer serves a second one.
    for prefix in ["memory.", "world_model.", "knowledge.", "curation."] {
        assert!(!methods.iter().any(|m| m.starts_with(prefix)), "{prefix}* must be gone");
    }
}

#[test]
fn checkpoint_write_failure_rolls_back_new_workflow_and_preserves_existing_state() {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("checkpoint.db");
    let host = Host::open(&database).unwrap();
    call(&host, "session.create", json!({"id":"checkpoint-session","title":"Checkpoint"}));
    let existing = call(&host, "supervisor.checkpoint", json!({
        "id":"existing", "session_id":"checkpoint-session", "objective":"keep evidence",
        "phase":"verify", "attempt":1, "max_attempts":3, "verdict":"reject",
        "evidence":["original evidence"], "pending":["retry"]
    }));
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_checkpoint_update BEFORE UPDATE ON workflow_runs
         WHEN NEW.phase='rejected-write' BEGIN
         SELECT RAISE(ABORT,'injected checkpoint update failure'); END;",
    ).unwrap();

    let checkpoint = json!({
        "id":"new", "session_id":"checkpoint-session", "objective":"finish safely",
        "phase":"rejected-write", "attempt":1, "max_attempts":2, "verdict":"accept",
        "evidence":["new evidence"], "pending":[]
    });
    assert!(error(&host, "supervisor.checkpoint", checkpoint.clone()).contains("injected checkpoint"));
    assert!(call(&host, "supervisor.resume", json!({"id":"new"})).is_null());

    let mut update = checkpoint.clone();
    update["id"] = json!("existing");
    assert!(error(&host, "supervisor.checkpoint", update).contains("injected checkpoint"));
    assert_eq!(call(&host, "supervisor.resume", json!({"id":"existing"})), existing);

    conn.execute_batch("DROP TRIGGER reject_checkpoint_update;").unwrap();
    let saved = call(&host, "supervisor.checkpoint", checkpoint);
    assert_eq!(saved["phase"], "rejected-write");
    assert_eq!(saved["status"], "completed");
    assert_eq!(saved["state"]["verdict"], "accept");
    drop(conn);
    drop(host);
    let restarted = Host::open(&database).unwrap();
    assert_eq!(call(&restarted, "supervisor.resume", json!({"id":"new"})), saved);
}

#[test]
fn detached_worktree_rpc_honors_base_and_defaults_to_head() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init"]);
    git(&repo, &["config", "user.email", "octocode@example.invalid"]);
    git(&repo, &["config", "user.name", "OctoCode Test"]);
    std::fs::write(repo.join("fixture.txt"), "base\n").unwrap();
    git(&repo, &["add", "fixture.txt"]);
    git(&repo, &["commit", "-m", "base"]);
    git(&repo, &["branch", "older-base"]);
    std::fs::write(repo.join("fixture.txt"), "head\n").unwrap();
    git(&repo, &["commit", "-am", "head"]);
    let revision = |name: &str| {
        let output = std::process::Command::new("git")
            .args(["rev-parse", name]).current_dir(&repo).output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    let base = revision("older-base");
    let head = revision("HEAD");
    assert_ne!(base, head);
    let host = Host::open(dir.path().join("worktree.db")).unwrap();
    for (name, base_branch, expected) in [
        ("explicit-base", Some("older-base"), &base),
        ("default-head", None, &head),
    ] {
        let target = dir.path().join(name);
        let created = call(&host, "worktree.create", json!({
            "cwd":repo,"path":target,"baseBranch":base_branch,"createNewBranch":false
        }));
        assert_eq!(created["success"], true);
        assert_eq!(created["worktree"]["commitHash"].as_str(), Some(expected.as_str()));
        assert_eq!(created["worktree"]["isDetached"], true);
        let listed = call(&host, "worktree.list", json!({"cwd":repo}));
        assert!(listed.as_array().unwrap().iter().any(|row|
            row["isDetached"] == true && row["commitHash"].as_str() == Some(expected.as_str())
        ));
        assert_eq!(call(&host, "worktree.delete", json!({"cwd":repo,"path":target,"force":false}))["success"], true);
        assert!(!target.exists());
    }
    let invalid = dir.path().join("invalid-base");
    assert!(!error(&host, "worktree.create", json!({
        "cwd":repo,"path":invalid,"baseBranch":"missing-base","createNewBranch":false
    })).is_empty());
    assert!(!invalid.exists());
    assert_eq!(revision("HEAD"), head);
    assert_eq!(call(&host, "worktree.list", json!({"cwd":repo})).as_array().unwrap().len(), 1);
}
