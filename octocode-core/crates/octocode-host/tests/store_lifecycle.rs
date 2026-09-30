use chrono::{Duration, Utc};
use octocode_host::store::{DEFAULT_LOG_RETENTION_DAYS, Store};
use serde_json::json;

#[test]
fn newer_schema_is_rejected_without_changing_database_bytes_or_marker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("newer.db");
    {
        let store = Store::open(&path).unwrap();
        store.create_session("future-session", "Keep data", None).unwrap();
        store.create_workflow("future-workflow", "future-session", "Keep state", &json!({"keep":true})).unwrap();
    }
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE;
             CREATE TABLE future_only(value TEXT NOT NULL);
             INSERT INTO future_only VALUES('preserve future data');
             UPDATE sessions SET status='running' WHERE id='future-session';
             PRAGMA user_version=7;",
        ).unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let rejected = Store::open(&path).err().expect("newer schema must be rejected");
    assert!(rejected.to_string().contains("schema version 7"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
    assert_eq!(conn.query_row("SELECT status FROM sessions WHERE id='future-session'", [], |row| row.get::<_, String>(0)).unwrap(), "running");
    assert_eq!(conn.query_row("SELECT status FROM workflow_runs WHERE id='future-workflow'", [], |row| row.get::<_, String>(0)).unwrap(), "running");
    assert_eq!(conn.query_row("SELECT value FROM future_only", [], |row| row.get::<_, String>(0)).unwrap(), "preserve future data");
}

#[test]
fn legacy_logs_migrate_to_the_developer_category() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE logs(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT, tool_run_id TEXT, level TEXT NOT NULL,
                subsystem TEXT NOT NULL, message TEXT NOT NULL,
                fields TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            INSERT INTO logs(level,subsystem,message,fields,created_at)
            VALUES ('info','rpc','legacy trace','{}',1);",
        )
        .unwrap();
    }

    let store = Store::open(&path).unwrap();
    let logs = store
        .filtered_logs("developer", None, None, None, None, 10)
        .unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].category, "developer");
    assert_eq!(logs[0].message, "legacy trace");
}

#[test]
fn session_message_setting_and_cascade_lifecycle_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("octocode.db");
    {
        let store = Store::open(&path).unwrap();
        let created = store
            .create_session("s1", "Initial", Some("D:/work"))
            .unwrap();
        assert_eq!(created.title, "Initial");
        store.append_message("m1", "s1", "user", "hello").unwrap();
        store
            .append_event(Some("s1"), "task.started", &json!({ "step": 1 }))
            .unwrap();
        store.set_setting("log_retention_days", &json!(30)).unwrap();
        assert!(store.update_session_title("s1", "Updated").unwrap());
        assert_eq!(store.session("s1").unwrap().unwrap().title, "Updated");
    }
    {
        let store = Store::open(&path).unwrap();
        let messages = store.messages("s1").unwrap();
        assert_eq!(messages[0].id, "m1");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(
            store.setting("log_retention_days").unwrap(),
            Some(json!(30))
        );
        assert!(store.delete_session("s1").unwrap());
        assert!(store.session("s1").unwrap().is_none());
        assert!(store.messages("s1").unwrap().is_empty());
        assert!(!store.delete_session("s1").unwrap());
    }
}

#[test]
fn retention_defaults_to_thirty_days_and_deletes_in_database() {
    assert_eq!(DEFAULT_LOG_RETENTION_DAYS, 30);
    let store = Store::open(":memory:").unwrap();
    let old = (Utc::now() - Duration::days(31)).timestamp_millis();
    store.insert_log("info", "test", "old", Some(old)).unwrap();
    store.insert_log("info", "test", "new", None).unwrap();
    let result = store
        .purge_expired_logs(DEFAULT_LOG_RETENTION_DAYS)
        .unwrap();
    assert_eq!(result.deleted_logs, 1);
    assert_eq!(store.log_count().unwrap(), 1);
}

#[test]
fn structured_logs_preserve_correlation_fields() {
    let store = Store::open(":memory:").unwrap();
    store.create_session("s1", "Task", None).unwrap();
    store
        .insert_log_detailed(
            "developer",
            "error",
            "agent",
            "tool failed",
            &json!({"task_id":"t1","duration_ms":42}),
            Some("s1"),
            None,
            None,
        )
        .unwrap();
    let log = store.logs(1).unwrap().pop().unwrap();
    assert_eq!(log.session_id.as_deref(), Some("s1"));
    assert_eq!(log.fields["task_id"], "t1");
    assert_eq!(log.fields["duration_ms"], 42);
}

#[test]
fn operational_records_have_closed_lifecycles() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("records.db")).unwrap();
    store.create_session("s1", "Task", None).unwrap();

    let tool = store
        .start_tool_run("t1", "s1", "shell", &json!({"cmd":"pwd"}))
        .unwrap();
    assert_eq!(tool.status, "running");
    assert!(
        store
            .finish_tool_run("t1", "completed", Some(&json!({"stdout":"ok"})), Some(0))
            .unwrap()
    );
    assert_eq!(store.tool_run("t1").unwrap().unwrap().exit_code, Some(0));

    store
        .create_artifact("a1", Some("s1"), "text/plain", "out.txt", "abc", &json!({}))
        .unwrap();
    assert!(
        store
            .update_artifact_metadata("a1", &json!({"view":"code"}))
            .unwrap()
    );
    assert_eq!(
        store.artifact("a1").unwrap().unwrap().metadata["view"],
        "code"
    );

    store
        .create_workflow("w1", "s1", "finish task", &json!({"step":0}))
        .unwrap();
    assert!(
        store
            .update_workflow("w1", "verify", "running", &json!({"step":1}))
            .unwrap()
    );
    assert_eq!(store.workflow("w1").unwrap().unwrap().phase, "verify");

    assert!(store.delete_tool_run("t1").unwrap());
    assert!(store.delete_artifact("a1").unwrap());
    assert!(store.delete_workflow("w1").unwrap());
    assert!(store.tool_run("t1").unwrap().is_none());
    assert!(store.artifact("a1").unwrap().is_none());
    assert!(store.workflow("w1").unwrap().is_none());
}

#[test]
fn restart_interrupts_only_unfinished_operational_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("restart.db");
    {
        let store = Store::open(&path).unwrap();
        store.create_session("running", "Running", None).unwrap();
        store.update_session_status("running", "running").unwrap();
        store
            .create_workflow("workflow", "running", "work", &json!({}))
            .unwrap();
        store
            .start_tool_run("tool", "running", "shell", &json!({}))
            .unwrap();

        store.create_session("done", "Done", None).unwrap();
        store.update_session_status("done", "needs_review").unwrap();
    }

    let store = Store::open(&path).unwrap();
    assert_eq!(store.session("running").unwrap().unwrap().status, "interrupted");
    assert_eq!(store.workflow("workflow").unwrap().unwrap().status, "interrupted");
    let tool = store.tool_run("tool").unwrap().unwrap();
    assert_eq!(tool.status, "interrupted");
    assert!(tool.finished_at.is_some());
    assert_eq!(store.session("done").unwrap().unwrap().status, "needs_review");
}

#[test]
fn concurrent_open_cannot_interrupt_a_live_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("concurrent.db");
    let live = Store::open(&path).unwrap();
    live.create_session("live", "Live", None).unwrap();
    live.update_session_status("live", "running").unwrap();
    live.create_workflow("workflow", "live", "work", &json!({}))
        .unwrap();

    assert!(Store::open(&path).is_err());
    assert_eq!(live.session("live").unwrap().unwrap().status, "running");
    assert_eq!(live.workflow("workflow").unwrap().unwrap().status, "running");

    drop(live);
    let recovered = Store::open(&path).unwrap();
    assert_eq!(recovered.session("live").unwrap().unwrap().status, "interrupted");
    assert_eq!(recovered.workflow("workflow").unwrap().unwrap().status, "interrupted");
}

#[test]
fn message_and_log_updates_keep_search_indexes_valid() {
    let store = Store::open(":memory:").unwrap();
    store.create_session("s1", "Task", None).unwrap();
    store
        .append_message("m1", "s1", "user", "first phrase")
        .unwrap();
    assert!(store.update_message("m1", "second phrase").unwrap());
    assert!(store.delete_message("m1").unwrap());
    assert!(store.messages("s1").unwrap().is_empty());

    let id = store
        .insert_log("info", "test", "indexed log", None)
        .unwrap();
    assert_eq!(store.logs(10).unwrap()[0].message, "indexed log");
    assert!(store.delete_log(id).unwrap());
    assert_eq!(store.log_count().unwrap(), 0);
}
