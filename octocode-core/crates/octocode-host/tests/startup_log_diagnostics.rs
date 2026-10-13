use octocode_host::{host::Host, protocol::Request, store::Store};
use rusqlite::Connection;
use serde_json::{Value, json};

fn health(host: &Host) -> Value {
    let r = host.dispatch(Request {id:json!(1),method:"health".into(),params:json!({})});
    assert!(r.error.is_none()); r.result.unwrap()
}

#[test]
fn startup_diagnostic_failure_returns_host_and_preserves_recovery_data_and_cold_reopen() {
    let dir = tempfile::tempdir().unwrap(); let path=dir.path().join("owned.db");
    {
        let store=Store::open(&path).unwrap(); store.create_session("owned","owned",None).unwrap();
        store.set_setting("other-key", &json!({"owned":true})).unwrap();
        store.set_setting("legacy-import:owned", &json!({"owned":true})).unwrap();
        let conn=Connection::open(&path).unwrap();
        conn.execute_batch("UPDATE sessions SET status='running' WHERE id='owned';
            INSERT INTO messages VALUES('owned-message','owned',0,'user','owned',1);
            CREATE TRIGGER owned_startup_abort BEFORE INSERT ON logs WHEN new.message='OctoCode host started' BEGIN SELECT RAISE(ABORT,'owned private startup marker'); END;").unwrap();
    }
    let host=Host::open(&path).expect("startup diagnostic failure must not block Host");
    assert_eq!(health(&host)["log_write_failures"],1);
    let ping=host.dispatch(Request {id:json!(2),method:"ping".into(),params:json!({})});
    assert_eq!(ping.result.unwrap()["pong"],true);
    let conn=Connection::open(&path).unwrap();
    assert_eq!(conn.query_row("SELECT status FROM sessions WHERE id='owned'",[],|r|r.get::<_,String>(0)).unwrap(),"interrupted");
    assert_eq!(conn.query_row("SELECT count(*) FROM messages WHERE session_id='owned'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT count(*) FROM settings WHERE key IN ('other-key','legacy-import:owned')",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert_eq!(conn.query_row("SELECT count(*) FROM logs WHERE message='OctoCode host started'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    conn.execute_batch("DROP TRIGGER owned_startup_abort").unwrap();
    assert_eq!(health(&host)["log_write_failures"],1,"recovery must not reset lifetime counter");
    drop(conn); drop(host);
    let reopened=Host::open(&path).unwrap(); assert_eq!(health(&reopened)["log_write_failures"],0);
    let conn=Connection::open(&path).unwrap();
    assert_eq!(conn.query_row("SELECT count(*) FROM logs WHERE message='OctoCode host started'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn healthy_startup_inserts_exact_original_fields_once_per_open() {
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("owned.db");
    let host=Host::open(&path).unwrap(); assert_eq!(health(&host)["log_write_failures"],0);
    let conn=Connection::open(&path).unwrap();
    let rows:Vec<(String,String,String,String)>=conn.prepare("SELECT category,level,subsystem,fields FROM logs WHERE message='OctoCode host started'").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(rows.len(),1);assert_eq!((&rows[0].0,&rows[0].1,&rows[0].2),(&"system".to_string(),&"info".to_string(),&"host".to_string()));
    assert_eq!(serde_json::from_str::<Value>(&rows[0].3).unwrap(),json!({"retention_days":30,"purged_logs":0}));
    drop(conn);drop(host);let reopened=Host::open(&path).unwrap();assert_eq!(health(&reopened)["log_write_failures"],0);
    let conn=Connection::open(&path).unwrap();assert_eq!(conn.query_row("SELECT count(*) FROM logs WHERE message='OctoCode host started'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
}

#[test]
fn purge_and_store_recovery_failures_remain_fatal_and_preserve_owned_rows() {
    for mode in ["purge","recovery","setting"] {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("owned.db");
        { let store=Store::open(&path).unwrap();store.create_session("owned","owned",None).unwrap();
          store.set_setting("other-key",&json!({"owned":true})).unwrap();store.set_setting("legacy-import:owned",&json!({"owned":true})).unwrap();
          let conn=Connection::open(&path).unwrap();
          conn.execute_batch("INSERT INTO logs(category,level,subsystem,message,fields,created_at) VALUES('system','info','owned','owned-old-log','{}',1)").unwrap();
          match mode {
            "purge"=>conn.execute_batch("CREATE TRIGGER owned_purge_abort BEFORE DELETE ON logs BEGIN SELECT RAISE(ABORT,'owned purge abort'); END;").unwrap(),
            "recovery"=>conn.execute_batch("UPDATE sessions SET status='running' WHERE id='owned'; CREATE TRIGGER owned_recovery_abort BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'owned recovery abort'); END;").unwrap(),
            _=>{conn.execute("INSERT INTO settings(key,value,updated_at) VALUES('log.retention_days',x'ff',1)",[]).unwrap();}
          }
        }
        let failure=Host::open(&path).err().expect("data/store/settings/purge failures remain fatal");
        if mode!="setting" {assert!(failure.to_string().contains(&format!("owned {mode} abort")));}
        let conn=Connection::open(&path).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM logs WHERE message='owned-old-log'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT count(*) FROM logs WHERE message='OctoCode host started'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT count(*) FROM settings WHERE key IN ('other-key','legacy-import:owned')",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        if mode=="recovery" {assert_eq!(conn.query_row("SELECT status FROM sessions WHERE id='owned'",[],|r|r.get::<_,String>(0)).unwrap(),"running");}
    }
}
