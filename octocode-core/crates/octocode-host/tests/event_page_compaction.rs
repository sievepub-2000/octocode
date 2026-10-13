use octocode_host::{host::Host, protocol::Request};
use serde_json::{Value, json};

fn call(host: &mut Host, method: &str, params: Value) -> Value {
    let response = host.dispatch(Request { id: json!(1), method: method.into(), params });
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

fn fixture(payloads: &[(&str, Value)]) -> (tempfile::TempDir, Host, Vec<i64>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    let mut host = Host::open(&path).unwrap();
    call(&mut host, "session.create", json!({"id":"owned","title":"owned"}));
    let connection = rusqlite::Connection::open(path).unwrap();
    let mut ids = vec![];
    for (kind, payload) in payloads {
        connection.execute("INSERT INTO events(session_id,kind,payload,created_at) VALUES('owned',?1,?2,1)", rusqlite::params![kind, payload.to_string()]).unwrap();
        ids.push(connection.last_insert_rowid());
    }
    (dir, host, ids)
}

#[test]
fn unicode_empty_raw_and_page_cursor_preserve_complete_content() {
    let (_dir, mut host, ids) = fixture(&[
        ("text",json!({"data":"你","type":"text"})),
        ("text",json!({"data":"","type":"text"})),
        ("text",json!({"data":"🙂","type":"text"})),
        ("thought",json!({"text":"思"})),
        ("thought",json!({"text":"考"})),
    ]);
    let first = call(&mut host,"event.page",json!({"session_id":"owned","presentation":true,"limit":2}));
    assert_eq!(first["rows"],json!([[ids[1],"text",{"data":"你","type":"text"}]]));
    assert_eq!(first["next"],ids[1]); assert_eq!(first["has_more"],true);
    let second = call(&mut host,"event.page",json!({"session_id":"owned","presentation":true,"after":ids[1],"limit":3}));
    assert_eq!(second["rows"],json!([[ids[2],"text",{"data":"🙂","type":"text"}],[ids[4],"thought",{"text":"思考"}]]));
    assert_eq!(second["next"],ids[4]); assert_eq!(second["has_more"],false);
    for method in ["event.page","event.list"] {
        let raw = call(&mut host,method,json!({"session_id":"owned","presentation":false,"limit":5}));
        let rows = if method == "event.page" { &raw["rows"] } else { &raw };
        assert_eq!(rows.as_array().unwrap().len(),5);
        assert_eq!(rows[1][2]["data"],"");
    }
    let raw_list = call(&mut host,"event.list",json!({"session_id":"owned","presentation":true,"limit":5}));
    assert_eq!(raw_list.as_array().unwrap().len(),5);
}

#[test]
fn metadata_key_type_and_non_string_barriers_are_unchanged() {
    let values = vec![
        json!({"data":"a","type":"text"}), json!({"data":"b","type":"other"}),
        json!({"data":"c","extra":true}), json!({"data":"d"}),
        json!({"text":"e"}), json!({"data":3}), json!({"data":null}),
        json!({"data":false}), json!({"data":[]}), json!({"data":{}}),
        json!("string"), json!(null), json!({"data":"f","text":"g"}),
    ];
    let events: Vec<_> = values.iter().cloned().map(|v|("text",v)).collect();
    let (_dir,mut host,ids)=fixture(&events);
    let page=call(&mut host,"event.page",json!({"session_id":"owned","presentation":true,"limit":2000}));
    assert_eq!(page["rows"].as_array().unwrap().len(),values.len());
    for (index,value) in values.iter().enumerate() { assert_eq!(&page["rows"][index][2],value); assert_eq!(page["rows"][index][0],ids[index]); }
}

#[test]
fn missing_type_empty_text_and_kind_changes_preserve_merge_predicates() {
    let (_dir,mut host,ids)=fixture(&[
        ("text",json!({"text":""})), ("text",json!({"text":"é"})),
        ("thought",json!({"data":"λ"})), ("thought",json!({"data":""})),
        ("log",json!({"data":"x"})), ("log",json!({"data":"y"})),
    ]);
    let page=call(&mut host,"event.page",json!({"session_id":"owned","presentation":true,"limit":2000}));
    assert_eq!(page["rows"],json!([[ids[1],"text",{"text":"é"}],[ids[3],"thought",{"data":"λ"}],[ids[4],"log",{"data":"x"}],[ids[5],"log",{"data":"y"}]]));
}
