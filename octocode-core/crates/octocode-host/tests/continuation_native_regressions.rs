use octocode_host::store::Store;
use std::{fs, path::Path};

#[test]
fn project_creation_commit_failure_removes_owned_index_and_membership() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("fixture.db");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let store = Store::open(&db).unwrap();
    store.create_session("owned", "fixture", workspace.to_str()).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE deferred_creation(project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_creation AFTER INSERT ON projects BEGIN INSERT INTO deferred_creation VALUES('absent-owned-fixture'); END;").unwrap();
    assert!(store.create_project("fixture", &["owned".into()], None).is_err());
    assert!(store.projects().unwrap().is_empty());
    assert!(store.session("owned").unwrap().unwrap().project_id.is_none());
    assert_eq!(fs::read_dir(workspace.join(".octocode/projects")).unwrap().count(), 0);
    conn.execute_batch("DROP TRIGGER reject_creation;").unwrap();
    drop(conn);
    drop(store);
    let reopened = Store::open(&db).unwrap();
    assert!(reopened.projects().unwrap().is_empty());
    let project = reopened.create_project("retry", &["owned".into()], None).unwrap();
    assert!(Path::new(&project.directory).join("artifacts.json").is_file());
    reopened.delete_project(&project.id).unwrap();
}

#[test]
fn project_rpc_rename_and_assignment_refresh_disk_indexes_after_reopen() {
    use octocode_host::{host::Host, protocol::Request};
    use serde_json::{Value, json};
    let call = |host: &Host, method: &str, params: Value| {
        let response = host.dispatch(Request { id: json!(1), method: method.into(), params });
        assert!(response.error.is_none(), "{method}: {:?}", response.error);
        response.result.unwrap()
    };
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("fixture.db");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let host = Host::open(&db).unwrap();
    let session = call(&host, "session.create", json!({"title":"owned", "workspace":workspace}));
    let sid = session["id"].as_str().unwrap();
    let result = call(&host, "project.create", json!({"name":"before", "session_ids":[sid]}));
    let project = &result["project"];
    let id = project["id"].as_str().unwrap();
    let index = Path::new(project["directory"].as_str().unwrap()).join("artifacts.json");
    let read_index = || serde_json::from_slice::<Value>(&fs::read(&index).unwrap()).unwrap();
    call(&host, "project.rename", json!({"id":id,"name":"after"}));
    assert_eq!(read_index()["project"]["name"], "after");
    call(&host, "project.assign", json!({"project_id":null,"session_ids":[sid]}));
    assert!(read_index()["sessions"].as_array().unwrap().is_empty());
    call(&host, "project.assign", json!({"project_id":id,"session_ids":[sid]}));
    assert_eq!(read_index()["sessions"][0]["session_id"], sid);
    drop(host);
    let reopened = Host::open(&db).unwrap();
    assert_eq!(read_index()["project"]["name"], "after");
    assert_eq!(call(&reopened, "session.get", json!({"id":sid}))["project_id"], id);
    call(&reopened, "project.delete", json!({"id":id}));
    call(&reopened, "session.delete", json!({"id":sid}));
}

#[test]
fn out_of_range_retention_returns_error_without_deleting_records() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("fixture.db");
    let store = Store::open(&db).unwrap();
    store.create_session("owned", "fixture", None).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("INSERT INTO logs(category,level,subsystem,message,fields,created_at) VALUES('system','info','fixture','owned','{}',0)", []).unwrap();
    assert!(store.purge_expired_logs(u32::MAX).is_err());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM logs", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    assert!(store.session("owned").unwrap().is_some());
    assert!(store.purge_expired_logs(30).is_ok());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM logs", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    store.set_setting("log.retention_days", &serde_json::json!(u32::MAX)).unwrap();
    drop(conn);
    drop(store);
    assert!(octocode_host::host::Host::open(&db).is_err());
    let reopened = Store::open(&db).unwrap();
    assert!(reopened.session("owned").unwrap().is_some());
    reopened.set_setting("log.retention_days", &serde_json::json!(30)).unwrap();
    drop(reopened);
    assert!(octocode_host::host::Host::open(&db).is_ok());
}

fn failed_delete_preserves_index(trigger: &str, missing_index: bool) {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("fixture.db");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let store = Store::open(&db).unwrap();
    store.create_session("owned", "fixture", workspace.to_str()).unwrap();
    let project = store.create_project("fixture", &["owned".into()], None).unwrap();
    let index = Path::new(&project.directory).join("artifacts.json");
    let original = fs::read(&index).unwrap();
    if missing_index { fs::remove_file(&index).unwrap(); }
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(trigger).unwrap();
    assert!(store.delete_project(&project.id).is_err());
    assert!(store.project(&project.id).is_ok());
    assert_eq!(store.session("owned").unwrap().unwrap().project_id.as_deref(), Some(project.id.as_str()));
    if missing_index { assert!(!index.exists()); }
    else { assert_eq!(fs::read(&index).unwrap(), original, "failed deletion must preserve the exact live index"); }
    conn.execute_batch("DROP TRIGGER reject_delete;").unwrap();
    drop(conn);
    drop(store);
    let reopened = Store::open(&db).unwrap();
    assert!(reopened.project(&project.id).is_ok());
    if missing_index { assert!(!index.exists()); }
    else { assert_eq!(fs::read(&index).unwrap(), original); }
    reopened.delete_project(&project.id).unwrap();
    assert!(reopened.project(&project.id).is_err());
    assert!(reopened.session("owned").unwrap().unwrap().project_id.is_none());
    let archived: serde_json::Value = serde_json::from_slice(&fs::read(&index).unwrap()).unwrap();
    assert_eq!(archived["archived"], true);
}

#[test]
fn project_delete_statement_failure_preserves_live_index_after_reopen() {
    failed_delete_preserves_index("CREATE TRIGGER reject_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END;", false);
}

#[test]
fn project_delete_commit_failure_preserves_live_index_after_reopen() {
    failed_delete_preserves_index("CREATE TABLE deferred_failure(project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_delete AFTER DELETE ON projects BEGIN INSERT INTO deferred_failure VALUES(OLD.id); END;", false);
}

#[test]
fn project_delete_commit_failure_does_not_leave_a_new_index() {
    failed_delete_preserves_index("CREATE TABLE deferred_failure(project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_delete AFTER DELETE ON projects BEGIN INSERT INTO deferred_failure VALUES(OLD.id); END;", true);
}

#[test]
fn project_delete_index_failure_preserves_database_membership() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let db = temp.path().join("fixture.db");
    let store = Store::open(&db).unwrap();
    store.create_session("owned", "fixture", workspace.to_str()).unwrap();
    let project = store.create_project("fixture", &["owned".into()], None).unwrap();
    let index = Path::new(&project.directory).join("artifacts.json");
    let original = fs::read(&index).unwrap();
    fs::remove_file(&index).unwrap();
    fs::create_dir(&index).unwrap();
    assert!(store.delete_project(&project.id).is_err());
    assert!(store.project(&project.id).is_ok());
    assert_eq!(store.session("owned").unwrap().unwrap().project_id.as_deref(), Some(project.id.as_str()));
    fs::remove_dir(&index).unwrap();
    fs::write(&index, &original).unwrap();
    drop(store);
    let reopened = Store::open(&db).unwrap();
    assert!(reopened.project(&project.id).is_ok());
    reopened.delete_project(&project.id).unwrap();
    assert!(reopened.project(&project.id).is_err());
}
