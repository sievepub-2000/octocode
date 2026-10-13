use octocode_host::{host::Host, protocol::Request};
use serde_json::{Value, json};

fn call(host: &Host, method: &str, params: Value) -> Value {
    let response = host.dispatch(Request { id: json!(1), method: method.into(), params });
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

fn prepare(host: &Host) -> Value {
    call(host, "harness.prepare", json!({"title":"fixture", "prompt":"inspect fixture",
        "provider":{"apiProvider":"openai","openAiBaseUrl":"http://127.0.0.1:9/v1",
        "openAiApiKey":"fixture","openAiModelId":"fixture"}}))
}

#[test]
fn lifecycle_session_write_failure_rolls_back_workflow_and_retries_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("lifecycle.db");
    let host = Host::open(&db).unwrap();
    let prepared = prepare(&host);
    let session = prepared["session_id"].as_str().unwrap();
    let task = prepared["task_id"].as_str().unwrap();
    let original = call(&host, "supervisor.resume", json!({"id":task}));
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_session BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'fixture session write failure'); END;").unwrap();
    assert!(host.record_agent_lifecycle(task, session, "agent.finished", &json!({"success":true})).is_err());
    assert_eq!(call(&host, "supervisor.resume", json!({"id":task})), original);
    assert_eq!(call(&host, "session.get", json!({"id":session}))["status"], "prepared");
    conn.execute_batch("DROP TRIGGER reject_session;").unwrap();
    assert_eq!(host.record_agent_lifecycle(task, session, "agent.finished", &json!({"success":true})).unwrap(), "needs_review");
    drop(conn);
    drop(host);
    let reopened = Host::open(&db).unwrap();
    assert_eq!(call(&reopened, "supervisor.resume", json!({"id":task}))["status"], "needs_review");
    assert_eq!(call(&reopened, "session.get", json!({"id":session}))["status"], "needs_review");
}

#[test]
fn transition_event_write_failure_preserves_session_and_commits_retry_once() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("transition.db");
    let host = Host::open(&db).unwrap();
    let prepared = prepare(&host);
    let session = prepared["session_id"].as_str().unwrap();
    let task = prepared["task_id"].as_str().unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_transition BEFORE INSERT ON events WHEN NEW.kind='harness.completed' BEGIN SELECT RAISE(ABORT,'fixture event write failure'); END;").unwrap();
    let params = json!({"session_id":session,"task_id":task,"state":"completed"});
    assert!(host.dispatch(Request {id:json!(2),method:"harness.transition".into(),params:params.clone()}).error.is_some());
    assert_eq!(call(&host, "session.get", json!({"id":session}))["status"], "prepared");
    conn.execute_batch("DROP TRIGGER reject_transition;").unwrap();
    call(&host, "harness.transition", params);
    drop(conn);
    drop(host);
    let reopened = Host::open(&db).unwrap();
    assert_eq!(call(&reopened, "session.get", json!({"id":session}))["status"], "completed");
    let events = call(&reopened, "event.list", json!({"session_id":session}));
    assert_eq!(events.as_array().unwrap().iter().filter(|row| row[1]=="harness.completed").count(), 1);
}

#[test]
fn stale_task_transition_preserves_current_session_checkpoint_and_events() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("stale-transition.db");
    let host = Host::open(&db).unwrap();
    let first = prepare(&host);
    let session = &first["session_id"];
    call(&host, "harness.transition", json!({"session_id":session,"task_id":first["task_id"],"state":"completed"}));
    let next = call(&host, "harness.continue", json!({"session_id":session,"prompt":"next request",
        "provider":{"apiProvider":"openai","openAiBaseUrl":"http://127.0.0.1:9/v1",
        "openAiApiKey":"fixture","openAiModelId":"fixture"}}));
    assert_ne!(first["task_id"], next["task_id"]);
    let current_session = call(&host, "session.get", json!({"id":session}));
    let checkpoint = call(&host, "supervisor.resume", json!({"id":next["task_id"]}));
    let events = call(&host, "event.list", json!({"session_id":session}));
    for state in ["running", "completed", "cancelled", "failed"] {
        let response = host.dispatch(Request {id:json!(2),method:"harness.transition".into(),
            params:json!({"session_id":session,"task_id":first["task_id"],"state":state})});
        assert_eq!(response.error.expect("stale task must be rejected").code, -32602);
        assert_eq!(call(&host, "session.get", json!({"id":session})), current_session);
        assert_eq!(call(&host, "supervisor.resume", json!({"id":next["task_id"]})), checkpoint);
        assert_eq!(call(&host, "event.list", json!({"session_id":session})), events);
    }
    for state in ["running", "completed"] {
        call(&host, "harness.transition", json!({"session_id":session,"task_id":next["task_id"],"state":state}));
        assert_eq!(call(&host, "session.get", json!({"id":session}))["status"], state);
    }
    drop(host);
    let reopened = Host::open(&db).unwrap();
    assert_eq!(call(&reopened, "session.get", json!({"id":session}))["status"], "completed");
    let resumed = call(&reopened, "supervisor.resume", json!({"id":next["task_id"]}));
    assert_eq!(resumed["state"], checkpoint["state"]);
    assert_eq!(resumed["session_id"], session.clone());
    // Reopening interrupts unfinished workflow runs under the existing policy.
    assert_eq!(resumed["status"], "interrupted");
}

#[test]
fn direct_harness_transition_checks_current_task_and_rejects_stale_or_other_sessions() {
    use octocode_host::{harness, store::Store};
    let store = Store::open(":memory:").unwrap();
    let provider = json!({"apiProvider":"openai","openAiBaseUrl":"http://127.0.0.1:9/v1",
        "openAiApiKey":"fixture","openAiModelId":"fixture"});
    let prepare_input = || serde_json::from_value(json!({"title":"fixture",
        "prompt":"first request","provider":provider})).unwrap();
    let first = harness::prepare(&store, prepare_input()).unwrap();
    let transition = |task: &str, state: &str| harness::transition(&store,
        serde_json::from_value(json!({"session_id":first.session_id,"task_id":task,"state":state})).unwrap());
    transition(&first.task_id, "completed").unwrap();
    let next = harness::continue_task(&store, serde_json::from_value(json!({
        "session_id":first.session_id,"prompt":"next request","provider":provider})).unwrap()).unwrap();
    let other = harness::prepare(&store, prepare_input()).unwrap();
    let checkpoint = serde_json::to_value(store.workflow(&next.task_id).unwrap()).unwrap();
    let events = store.events(&first.session_id, 0).unwrap();
    for task in [first.task_id.as_str(), other.task_id.as_str(), "", "missing-task"] {
        for state in ["running", "completed", "cancelled", "failed"] {
            assert!(transition(task, state).is_err(), "unbound task {task} must be rejected");
            assert_eq!(store.session(&first.session_id).unwrap().unwrap().status, "prepared");
            assert_eq!(serde_json::to_value(store.workflow(&next.task_id).unwrap()).unwrap(), checkpoint);
            assert_eq!(store.events(&first.session_id, 0).unwrap(), events);
            assert_eq!(store.session(&other.session_id).unwrap().unwrap().status, "prepared");
        }
    }
    for state in ["running", "cancelled", "failed", "completed"] {
        transition(&next.task_id, state).unwrap();
        assert_eq!(store.session(&first.session_id).unwrap().unwrap().status, state);
    }
}

#[test]
fn prepared_task_transitions_accept_current_identity_and_reject_other_sessions() {
    let host = Host::open(":memory:").unwrap();
    let other = prepare(&host);
    for state in ["running", "completed", "cancelled", "failed"] {
        let current = prepare(&host);
        let session = &current["session_id"];
        let before = call(&host, "session.get", json!({"id":session}));
        for task in [json!(""), json!("missing-task"), other["task_id"].clone()] {
            let response = host.dispatch(Request {id:json!(2),method:"harness.transition".into(),
                params:json!({"session_id":session,"task_id":task,"state":state})});
            assert_eq!(response.error.expect("unbound task must be rejected").code, -32602);
            assert_eq!(call(&host, "session.get", json!({"id":session})), before);
        }
        call(&host, "harness.transition", json!({"session_id":session,"task_id":current["task_id"],"state":state}));
        assert_eq!(call(&host, "session.get", json!({"id":session}))["status"], state);
    }
}

#[test]
fn invalid_retention_setting_is_rejected_without_replacing_saved_value() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("retention-validation.db");
    let host = Host::open(&db).unwrap();
    call(&host, "setting.set", json!({"key":"log.retention_days","value":30}));
    for value in [json!(0), json!(3651), json!(u32::MAX), json!(u64::MAX), json!(-1),
        json!(1.5), json!("30"), json!(null), json!({}), json!(true)] {
        let response = host.dispatch(Request {id:json!(2),method:"setting.set".into(),
            params:json!({"key":"log.retention_days","value":value})});
        assert_eq!(response.error.expect("unsupported retention must be rejected").code, -32602);
        assert_eq!(call(&host, "setting.get", json!({"key":"log.retention_days"})), 30);
    }
    drop(host);
    let reopened = Host::open(&db).unwrap();
    assert_eq!(call(&reopened, "setting.get", json!({"key":"log.retention_days"})), 30);
}

#[test]
fn supported_retention_bounds_survive_reopen_and_other_keys_remain_unrestricted() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("retention-bounds.db");
    for days in [1, 30, 3650] {
        let host = Host::open(&db).unwrap();
        call(&host, "setting.set", json!({"key":"log.retention_days","value":days}));
        call(&host, "log.purge", json!({"retention_days":days}));
        for (key, value) in [("arbitrary-setting",json!({"nested":[null,true,"free"]})),
            ("log.retentionDays",json!(u32::MAX)), ("message-queue:fixture",json!([{"text":"queued"}]))] {
            call(&host, "setting.set", json!({"key":key,"value":value}));
            assert_eq!(call(&host, "setting.get", json!({"key":key})), value);
        }
        drop(host);
        let reopened = Host::open(&db).unwrap();
        assert_eq!(call(&reopened, "setting.get", json!({"key":"log.retention_days"})), days);
        assert_eq!(call(&reopened, "setting.get", json!({"key":"log.retentionDays"})), u32::MAX);
    }
}

#[test]
fn legacy_retention_values_keep_existing_open_semantics() {
    use octocode_host::store::Store;
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("legacy-retention.db");
    for value in [json!(0), json!(3651), json!("legacy-value")] {
        let store = Store::open(&db).unwrap();
        store.set_setting("log.retention_days", &value).unwrap();
        store.insert_log("info", "fixture", "owned recent log", None).unwrap();
        drop(store);
        let host = Host::open(&db).unwrap();
        assert_eq!(call(&host, "setting.get", json!({"key":"log.retention_days"})), value);
        let logs = call(&host, "log.list", json!({"category":"developer","limit":1000}));
        assert!(logs.as_array().unwrap().iter().any(|row| row["message"] == "owned recent log"));
        call(&host, "setting.set", json!({"key":"log.retention_days","value":30}));
    }
}
