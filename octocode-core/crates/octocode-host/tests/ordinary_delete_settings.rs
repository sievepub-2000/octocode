use octocode_host::store::Store;
use rusqlite::Connection;
use serde_json::json;

#[test]
fn ordinary_delete_cleans_exact_runtime_queue_keys_and_preserves_other_settings_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.db");
    let store = Store::open(&path).unwrap();
    for id in ["owned", "owned-other"] { store.create_session(id, "owned", None).unwrap(); }
    for key in ["runtime-session:owned", "message-queue:owned", "runtime-session:owned-other", "message-queue:owned-other", "runtime-session:owned:extra", "credentials:owned", "legacy-import:owned"] {
        store.set_setting(key, &json!({"owned":true})).unwrap();
    }
    assert!(store.delete_session("owned").unwrap());
    for key in ["runtime-session:owned", "message-queue:owned"] { assert!(store.setting(key).unwrap().is_none(), "{key}"); }
    drop(store);
    let store = Store::open(&path).unwrap();
    assert!(store.session("owned").unwrap().is_none());
    assert!(store.session("owned-other").unwrap().is_some());
    for key in ["runtime-session:owned", "message-queue:owned"] { assert!(store.setting(key).unwrap().is_none()); }
    for key in ["runtime-session:owned-other", "message-queue:owned-other", "runtime-session:owned:extra", "credentials:owned", "legacy-import:owned"] {
        assert_eq!(store.setting(key).unwrap(), Some(json!({"owned":true})), "{key}");
    }
}

#[test]
fn absent_session_keeps_false_result_and_cleans_only_exact_session_keys() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("owned.db")).unwrap();
    for key in ["message-queue:absent", "runtime-session:absent", "runtime-session:absent-extra", "legacy-import:absent"] { store.set_setting(key, &json!([])).unwrap(); }
    assert!(!store.delete_session("absent").unwrap());
    assert!(store.setting("message-queue:absent").unwrap().is_none());
    assert!(store.setting("runtime-session:absent").unwrap().is_none());
    assert_eq!(store.setting("runtime-session:absent-extra").unwrap(), Some(json!([])));
    assert_eq!(store.setting("legacy-import:absent").unwrap(), Some(json!([])));
}

#[test]
fn settings_abort_rolls_back_session_all_cascades_and_both_keys_then_recovers() {
    for key in ["message-queue:owned", "runtime-session:owned"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owned.db");
        let store = Store::open(&path).unwrap();
        store.create_session("owned", "owned", None).unwrap();
        store.set_setting("message-queue:owned", &json!([])).unwrap();
        store.set_setting("runtime-session:owned", &json!({"owned":true})).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("INSERT INTO messages VALUES('owned-message','owned',0,'user','owned',1);
            INSERT INTO events(session_id,kind,payload,created_at) VALUES('owned','text','null',1);
            INSERT INTO tool_runs(id,session_id,name,input,status,started_at) VALUES('owned-tool','owned','owned','null','completed',1);
            INSERT INTO artifacts(id,session_id,mime_type,path,sha256,created_at) VALUES('owned-artifact','owned','text/plain','owned','owned',1);
            INSERT INTO workflow_runs(id,session_id,objective,phase,status,state,created_at,updated_at) VALUES('owned-workflow','owned','owned','done','completed','null',1,1);").unwrap();
        conn.execute_batch(&format!("CREATE TRIGGER owned_abort BEFORE DELETE ON settings WHEN old.key='{key}' BEGIN SELECT RAISE(ABORT,'owned settings abort'); END;")).unwrap();
        drop(conn);
        drop(store);
        let store = Store::open(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        assert!(store.session("owned").unwrap().is_some());
        let error = store.delete_session("owned").unwrap_err();
        assert!(error.to_string().contains("owned settings abort"), "{key}: {error}");
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(store.session("owned").unwrap().is_some());
        for table in ["messages", "events", "tool_runs", "artifacts", "workflow_runs"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {table} WHERE session_id='owned'"), [], |r| r.get::<_,i64>(0)).unwrap(), 1, "{key}/{table}");
        }
        assert_eq!(store.setting("message-queue:owned").unwrap(), Some(json!([])));
        assert_eq!(store.setting("runtime-session:owned").unwrap(), Some(json!({"owned":true})));
        conn.execute_batch("DROP TRIGGER owned_abort").unwrap();
        drop(conn);
        drop(store);
        let store = Store::open(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        assert!(store.delete_session("owned").unwrap());
        for table in ["messages", "events", "tool_runs", "artifacts", "workflow_runs"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {table} WHERE session_id='owned'"), [], |r| r.get::<_,i64>(0)).unwrap(), 0);
        }
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert!(reopened.session("owned").unwrap().is_none());
        assert!(reopened.setting("runtime-session:owned").unwrap().is_none());
        assert!(reopened.setting("message-queue:owned").unwrap().is_none());
    }
}
