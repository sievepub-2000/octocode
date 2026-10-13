use octocode_host::{host::Host, protocol::Request, store::Store};
use rusqlite::Connection;
use serde_json::{Value, json};

const ERROR_MESSAGE: &str = "event.list resource limit exceeded; use event.page with presentation=false";

fn dispatch(host: &Host, params: Value) -> octocode_host::protocol::Response {
    host.dispatch(Request { id: json!(1), method: "event.list".into(), params })
}

#[test]
fn default_raw_list_rejects_2001_actual_rows_without_partial_result() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.sqlite");
    let host = Host::open(&path).unwrap();
    host.dispatch(Request { id: json!(0), method: "session.create".into(), params: json!({"id":"owned","title":"owned"}) });
    let mut conn = Connection::open(&path).unwrap();
    let tx = conn.transaction().unwrap();
    for _ in 0..2001 {
        tx.execute("INSERT INTO events(session_id,kind,payload,created_at) VALUES('owned','text','null',1)", []).unwrap();
    }
    tx.commit().unwrap();
    let response = dispatch(&host, json!({"session_id":"owned"}));
    assert!(response.result.is_none(), "no partial array or empty-success fallback");
    let error = response.error.expect("actual row budget must reject");
    assert_eq!(error.code, -32005);
    assert_eq!(error.message, ERROR_MESSAGE);
}

fn owned() -> (tempfile::TempDir, Host, Connection) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.sqlite");
    let host = Host::open(&path).unwrap();
    assert!(host.dispatch(Request { id: json!(0), method: "session.create".into(), params: json!({"id":"owned","title":"owned"}) }).error.is_none());
    let conn = Connection::open(path).unwrap();
    (temp, host, conn)
}
fn insert(conn: &Connection, kind: &str, payload: &str) -> i64 {
    conn.execute("INSERT INTO events(session_id,kind,payload,created_at) VALUES('owned',?1,?2,1)", [kind, payload]).unwrap();
    conn.last_insert_rowid()
}
fn success(response: octocode_host::protocol::Response) -> Vec<Value> {
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap().as_array().unwrap().clone()
}
fn exceeded(response: octocode_host::protocol::Response) {
    assert!(response.result.is_none());
    let error = response.error.unwrap();
    assert_eq!(error.code, -32005);
    assert_eq!(error.message, ERROR_MESSAGE);
}

#[test]
fn actual_row_budget_preserves_large_limits_and_small_requested_ranges() {
    for count in [2000, 2001] {
        let (_temp, host, conn) = owned();
        conn.execute_batch("BEGIN").unwrap();
        for _ in 0..count { insert(&conn, "text", "null"); }
        conn.execute_batch("COMMIT").unwrap();
        for limit in [None, Some(Value::Null), Some(json!(i64::MAX)), Some(json!(5000)), Some(json!(2001))] {
            let mut params = json!({"session_id":"owned"});
            if let Some(limit) = limit { params["limit"] = limit; }
            let response = dispatch(&host, params);
            if count == 2000 { assert_eq!(success(response).len(), 2000); } else { exceeded(response); }
        }
        assert_eq!(success(dispatch(&host, json!({"session_id":"owned","limit":2000}))).len(), 2000);
        assert_eq!(success(dispatch(&host, json!({"session_id":"owned","limit":1}))).len(), 1);
        for limit in [0, -1] { assert_eq!(dispatch(&host, json!({"session_id":"owned","limit":limit})).error.unwrap().code, -32602); }
    }
}

#[test]
fn after_selects_the_budget_and_rejection_preserves_history_after_reopen() {
    let (temp, host, conn) = owned();
    conn.execute_batch("BEGIN").unwrap();
    for _ in 0..2001 { insert(&conn, "text", "null"); }
    conn.execute_batch("COMMIT").unwrap();
    exceeded(dispatch(&host, json!({"session_id":"owned"})));
    assert_eq!(success(dispatch(&host, json!({"session_id":"owned","after":1}))).len(), 2000);
    assert_eq!(success(dispatch(&host, json!({"session_id":"owned","after":2000}))).len(), 1);
    assert!(success(dispatch(&host, json!({"session_id":"owned","after":i64::MAX}))).is_empty());
    assert!(success(dispatch(&host, json!({"session_id":"missing"}))).is_empty());
    assert_eq!(dispatch(&host, json!({"session_id":"owned","after":-1})).error.unwrap().code, -32602);
    assert_eq!(conn.query_row("SELECT count(*) FROM events", [], |r| r.get::<_,i64>(0)).unwrap(), 2001);
    drop(conn); drop(host);
    let reopened = Host::open(temp.path().join("owned.sqlite")).unwrap();
    exceeded(dispatch(&reopened, json!({"session_id":"owned"})));
    assert_eq!(success(dispatch(&reopened, json!({"session_id":"owned","after":1}))).len(), 2000);
}

#[test]
fn kind_and_payload_bytes_obey_exact_minus_plus_one_and_cumulative_budget() {
    const BYTES: usize = 8 * 1024 * 1024;
    let (_temp, host, conn) = owned();
    for delta in [-1_isize, 0, 1] {
        conn.execute("DELETE FROM events", []).unwrap();
        let length = (BYTES as isize - 6 + delta) as usize;
        let payload = serde_json::to_string(&"x".repeat(length)).unwrap();
        assert_eq!(4 + payload.len(), (BYTES as isize + delta) as usize);
        insert(&conn, "text", &payload);
        let response = dispatch(&host, json!({"session_id":"owned"}));
        if delta > 0 { exceeded(response); } else { assert_eq!(success(response)[0][2].as_str().unwrap().len(), length); }
    }
    conn.execute("DELETE FROM events", []).unwrap();
    insert(&conn, "text", &serde_json::to_string(&"x".repeat(BYTES - 7)).unwrap());
    insert(&conn, "k", "null");
    exceeded(dispatch(&host, json!({"session_id":"owned"})));
    assert_eq!(success(dispatch(&host, json!({"session_id":"owned","limit":1}))).len(), 1);
}

#[test]
fn unicode_and_nul_use_utf8_blob_bytes_not_sqlite_character_length() {
    const BYTES: usize = 8 * 1024 * 1024;
    let (_temp, host, conn) = owned();
    let text = "é".repeat((BYTES - 6) / 2) + "x";
    let payload = serde_json::to_string(&text).unwrap();
    assert_eq!("中".len() + payload.len(), BYTES);
    insert(&conn, "中", &payload);
    assert_eq!(success(dispatch(&host, json!({"session_id":"owned"})))[0][2], json!(text));
    conn.execute("UPDATE events SET payload=?1", [serde_json::to_string(&(text + "é")).unwrap()]).unwrap();
    exceeded(dispatch(&host, json!({"session_id":"owned"})));
    conn.execute("DELETE FROM events", []).unwrap();
    insert(&conn, "k", &"\0".repeat(BYTES));
    exceeded(dispatch(&host, json!({"session_id":"owned"})));
}

#[test]
fn projection_json_null_and_original_raw_page_events_contracts_are_preserved() {
    const BYTES: usize = 8 * 1024 * 1024;
    let (temp, host, conn) = owned();
    let giant = serde_json::to_string(&"x".repeat(BYTES)).unwrap();
    insert(&conn, "tool_call_update", &giant);
    insert(&conn, "available_commands", &giant);
    exceeded(dispatch(&host, json!({"session_id":"owned"})));
    let projected = success(dispatch(&host, json!({"session_id":"owned","presentation":true})));
    assert_eq!(projected.len(), 2);
    assert!(projected.iter().all(|r| r[2].is_null()));
    let page = host.dispatch(Request { id: json!(1), method: "event.page".into(), params: json!({"session_id":"owned","limit":1,"presentation":false}) });
    assert_eq!(page.result.unwrap()["rows"][0][2].as_str().unwrap().len(), BYTES);
    conn.execute("DELETE FROM events", []).unwrap();
    for payload in ["{\"data\":\"owned\",\"type\":\"text\"}", "null", "not-json"] { insert(&conn, "text", payload); }
    let rows = success(dispatch(&host, json!({"session_id":"owned"})));
    assert_eq!(rows[0][2], json!({"data":"owned","type":"text"}));
    assert!(rows[1][2].is_null() && rows[2][2].is_null());
    drop(conn); drop(host);
    let store = Store::open(temp.path().join("owned.sqlite")).unwrap();
    assert_eq!(store.events("owned", 0).unwrap().len(), 3);
    assert_eq!(store.bounded_event_list("owned", 0, i64::MAX, false).unwrap().unwrap(), store.events("owned", 0).unwrap());
}

#[test]
fn sqlite_errors_close_read_transaction_and_recovery_survives_reopen() {
    let (temp, host, conn) = owned();
    insert(&conn, "text", "null");
    conn.execute_batch("ALTER TABLE events RENAME TO owned_events").unwrap();
    let response = dispatch(&host, json!({"session_id":"owned"}));
    assert!(response.result.is_none());
    assert_eq!(response.error.unwrap().code, -32000);
    conn.execute_batch("ALTER TABLE owned_events RENAME TO events").unwrap();
    assert_eq!(success(dispatch(&host, json!({"session_id":"owned"}))).len(), 1);
    conn.execute("UPDATE events SET payload=x'ff'", []).unwrap();
    assert_eq!(dispatch(&host, json!({"session_id":"owned"})).error.unwrap().code, -32000);
    conn.execute("UPDATE events SET payload='null'", []).unwrap();
    assert_eq!(success(dispatch(&host, json!({"session_id":"owned"}))).len(), 1);
    drop(conn); drop(host);
    let reopened = Host::open(temp.path().join("owned.sqlite")).unwrap();
    assert_eq!(success(dispatch(&reopened, json!({"session_id":"owned"}))).len(), 1);
}

#[test]
fn concurrent_wal_writer_cannot_replace_preflighted_payload_in_read_snapshot() {
    use std::sync::{Barrier, atomic::{AtomicUsize, Ordering}};
    use std::time::Duration;
    const BYTES: usize = 8 * 1024 * 1024;
    let (temp, host, conn) = owned();
    conn.execute_batch("BEGIN").unwrap();
    for _ in 0..1999 { insert(&conn, "text", "null"); }
    let last = insert(&conn, "text", "\"owned\"");
    conn.execute_batch("COMMIT").unwrap();
    drop(conn); drop(host);
    let path = temp.path().join("owned.sqlite");
    let store = Store::open(&path).unwrap();
    let barrier = Barrier::new(2);
    let commits = AtomicUsize::new(0);
    let mut overlap = 0;
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let writer = Connection::open(&path).unwrap();
            writer.busy_timeout(Duration::from_secs(5)).unwrap();
            let giant = serde_json::to_string(&"x".repeat(BYTES)).unwrap();
            barrier.wait();
            for index in 0..32 {
                writer.execute("UPDATE events SET payload=?1 WHERE sequence=?2", rusqlite::params![if index % 2 == 0 { giant.as_str() } else { "\"owned\"" }, last]).unwrap();
                commits.fetch_add(1, Ordering::SeqCst);
            }
        });
        barrier.wait();
        for _ in 0..64 {
            let before = commits.load(Ordering::SeqCst);
            let result = store.bounded_event_list("owned", 0, i64::MAX, false).unwrap();
            if commits.load(Ordering::SeqCst) > before { overlap += 1; }
            if let Some(rows) = result {
                assert_eq!(rows.len(), 2000);
                assert_eq!(rows.last().unwrap().2, json!("owned"), "oversized replacement must never escape");
            }
        }
    });
    assert_eq!(commits.load(Ordering::SeqCst), 32);
    assert!(overlap > 0, "owned WAL commits must actually overlap checked read calls");
    println!("owned snapshot reads=64 writer commits=32 overlapping calls={overlap}");
    assert_eq!(store.bounded_event_list("owned", 0, i64::MAX, false).unwrap().unwrap().len(), 2000);
}
