use octocode_host::{host::Host, protocol::Request};
use serde_json::{Value, json};

fn call(host: &Host, method: &str, params: Value) -> Value {
    let response = host.dispatch(Request { id:json!(1), method:method.into(), params });
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

#[test]
fn guarded_cleanup_identity_state_start_rollback_and_reopen() {
    for case in ["prepared", "failed", "started", "late-start", "wrong-task", "stale", "legacy", "running", "missing-task", "rollback-session", "rollback-queue", "rollback-runtime"] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("owned.db");
        let host = Host::open(&db).unwrap();
        let prepared = call(&host,"harness.prepare",json!({"title":"owned","prompt":"owned","provider":{"apiProvider":"openai","openAiModelId":"owned"}}));
        let session = prepared["session_id"].as_str().unwrap();
        let task = prepared["task_id"].as_str().unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        for prefix in ["message-queue", "runtime-session"] {
            call(&host,"setting.set",json!({"key":format!("{prefix}:{session}"),"value":if prefix=="message-queue" {json!([])} else {json!({"owned":true})}}));
        }
        if matches!(case,"failed"|"late-start") {
            call(&host,"harness.transition",json!({"session_id":session,"task_id":task,"state":"failed"}));
        }
        if matches!(case,"started"|"late-start") {
            call(&host,"event.append",json!({"session_id":session,"kind":"agent.started","payload":{}}));
        }
        if matches!(case,"stale"|"legacy") {
            call(&host,"event.append",json!({"session_id":session,"kind":if case=="legacy" {"legacy.turn"} else {"harness.prepared"},"payload":{"task_id":"other"}}));
        }
        if case=="running" { conn.execute("UPDATE sessions SET status='running' WHERE id=?1",[session]).unwrap(); }
        if case=="missing-task" { conn.execute("DELETE FROM workflow_runs WHERE id=?1",[task]).unwrap(); }
        if case=="rollback-session" { conn.execute_batch("CREATE TRIGGER reject_session BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'owned rollback'); END;").unwrap(); }
        if case=="rollback-queue" { conn.execute_batch("CREATE TRIGGER reject_setting BEFORE DELETE ON settings WHEN old.key LIKE 'message-queue:%' BEGIN SELECT RAISE(ABORT,'owned rollback'); END;").unwrap(); }
        if case=="rollback-runtime" { conn.execute_batch("CREATE TRIGGER reject_setting BEFORE DELETE ON settings WHEN old.key LIKE 'runtime-session:%' BEGIN SELECT RAISE(ABORT,'owned rollback'); END;").unwrap(); }
        let response=host.dispatch(Request { id:json!(2),method:"session.delete".into(),params:json!({"id":session,"expected_unstarted_task":if case=="wrong-task" {"other"} else {task}}) });
        let success=matches!(case,"prepared"|"failed");
        if case.starts_with("rollback-") { assert!(response.error.is_some()); }
        else { assert!(response.error.is_none()); assert_eq!(response.result.unwrap()["deleted"],success); }
        drop(conn); drop(host);
        let reopened=Host::open(&db).unwrap();
        assert_eq!(call(&reopened,"session.get",json!({"id":session})).is_null(),success,"{case}");
        for prefix in ["message-queue","runtime-session"] {
            assert_eq!(call(&reopened,"setting.get",json!({"key":format!("{prefix}:{session}")})).is_null(),success,"{case}");
        }
    }
}

#[test]
fn handoff_pending_queue_is_retained_without_overwriting_source_new_queue() {
    let dir=tempfile::tempdir().unwrap();let db=dir.path().join("owned.db");let host=Host::open(&db).unwrap();
    call(&host,"session.create",json!({"id":"owned-source","title":"owned","workspace":dir.path()}));
    call(&host,"message.append",json!({"session_id":"owned-source","role":"user","content":"owned"}));
    let queue=json!([{"id":"owned-1","text":"synthetic"},{"id":"owned-2","text":"synthetic"},{"id":"owned-3","text":"synthetic"}]);
    call(&host,"setting.set",json!({"key":"message-queue:owned-source","value":queue}));
    let p=call(&host,"harness.handoff",json!({"source_session_id":"owned-source","provider":{"apiProvider":"openai","openAiModelId":"owned"}}));
    let target=p["session_id"].as_str().unwrap();
    assert!(call(&host,"setting.get",json!({"key":"message-queue:owned-source"})).is_null());
    assert_eq!(call(&host,"setting.get",json!({"key":format!("message-queue:{target}")})).as_array().unwrap().len(),3);
    call(&host,"setting.set",json!({"key":format!("runtime-session:{target}"),"value":{"owned":true}}));
    let newer=json!([{"id":"owned-new","text":"synthetic"}]);
    call(&host,"setting.set",json!({"key":"message-queue:owned-source","value":newer}));
    assert_eq!(call(&host,"session.delete",json!({"id":target,"expected_unstarted_task":p["task_id"]}))["deleted"],false);
    drop(host);let reopened=Host::open(&db).unwrap();
    assert!(!call(&reopened,"session.get",json!({"id":target})).is_null());
    assert!(call(&reopened,"setting.get",json!({"key":format!("message-queue:{target}")}))==queue);
    assert!(call(&reopened,"setting.get",json!({"key":"message-queue:owned-source"}))==newer);
    assert_eq!(call(&reopened,"setting.get",json!({"key":format!("runtime-session:{target}")}))["owned"],true);
    // Explicit user deletion keeps its existing failed-session contract.
    call(&reopened,"harness.transition",json!({"session_id":target,"task_id":p["task_id"],"state":"failed"}));
    assert_eq!(call(&reopened,"session.delete",json!({"id":target}))["deleted"],true);
}

#[test]
fn automatic_cleanup_accepts_only_absent_or_valid_empty_queue() {
    for raw in [None,Some("[]"),Some(" [ ] \n"),Some("[{}]"),Some("{}"),Some("null"),Some("false"),Some("\"\""),Some(""),Some("["),Some("[null]")] {
        let dir=tempfile::tempdir().unwrap();let db=dir.path().join("owned.db");let host=Host::open(&db).unwrap();
        let p=call(&host,"harness.prepare",json!({"title":"owned","prompt":"owned","provider":{"apiProvider":"openai","openAiModelId":"owned"}}));
        let id=p["session_id"].as_str().unwrap();let conn=rusqlite::Connection::open(&db).unwrap();
        if let Some(raw)=raw { conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,0)",rusqlite::params![format!("message-queue:{id}"),raw]).unwrap(); }
        call(&host,"setting.set",json!({"key":format!("runtime-session:{id}"),"value":{"owned":true}}));
        let allowed=raw.is_none()||matches!(raw,Some("[]"|" [ ] \n"));
        assert_eq!(call(&host,"session.delete",json!({"id":id,"expected_unstarted_task":p["task_id"]}))["deleted"],allowed);
        drop(host);let reopened=Host::open(&db).unwrap();
        assert_eq!(call(&reopened,"session.get",json!({"id":id})).is_null(),allowed);
        assert_eq!(call(&reopened,"setting.get",json!({"key":format!("runtime-session:{id}")})).is_null(),allowed);
        if !allowed {
            let retained:String=conn.query_row("SELECT value FROM settings WHERE key=?1",[format!("message-queue:{id}")],|row|row.get(0)).unwrap();
            assert!(Some(retained.as_str())==raw); // Do not print queue values on assertion failure.
        }
    }
}

#[test]
fn guarded_validation_and_ordinary_delete_compatibility() {
    let dir=tempfile::tempdir().unwrap(); let host=Host::open(dir.path().join("owned.db")).unwrap();
    for flag in [Value::Null,json!(false),json!(""),json!(" ")] {
        let r=host.dispatch(Request{id:json!(1),method:"session.delete".into(),params:json!({"id":"owned","expected_unstarted_task":flag})});
        assert!(r.error.is_some());
    }
    assert_eq!(call(&host,"session.delete",json!({"id":"absent","expected_unstarted_task":"missing"}))["deleted"],false);
    let p=call(&host,"harness.prepare",json!({"title":"owned","prompt":"owned","provider":{"apiProvider":"openai","openAiModelId":"owned"}}));
    let id=p["session_id"].as_str().unwrap();
    assert!(host.dispatch(Request{id:json!(1),method:"session.delete".into(),params:json!({"id":id})}).error.is_some());
    call(&host,"harness.transition",json!({"session_id":id,"task_id":p["task_id"],"state":"failed"}));
    assert_eq!(call(&host,"session.delete",json!({"id":id}))["deleted"],true);
}
