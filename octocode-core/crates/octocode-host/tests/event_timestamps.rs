use octocode_host::{agent::AgentEvent, host::Host, protocol::Request};
use serde_json::{Value, json};

fn call(host: &Host, params: Value) -> Value {
    let response = host.dispatch(Request { id: json!(1), method: "event.page".into(), params });
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

#[test]
fn event_times_preserve_first_delta_across_pages_restart_and_legacy_clients() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    let host = Host::open(&path).unwrap();
    host.dispatch(Request { id: json!(1), method: "session.create".into(), params: json!({"id":"owned","title":"owned"}) }).result.unwrap();
    let start = 1_792_299_540_000_i64;
    let mut ids = Vec::new();
    for (index, kind) in ["thought", "thought", "tool_call", "text", "text"].into_iter().enumerate() {
        let event = AgentEvent { task_id: "task".into(), session_id: "owned".into(), kind: kind.into(), payload: json!({"data":index.to_string()}), created_at: start + index as i64 * 60_000 };
        let live = serde_json::to_value(&event).unwrap();
        assert_eq!(live["created_at"], event.created_at);
        ids.push(host.record_event_at(&event.session_id, &event.kind, &event.payload, event.created_at).unwrap());
    }
    let params = json!({"session_id":"owned","presentation":true,"include_timestamps":true,"limit":2});
    let first = call(&host, params.clone());
    assert_eq!(first["rows"], json!([[ids[1],"thought",{"data":"01"},start]]));
    assert_eq!(first["next"], ids[1]);
    let second = call(&host, json!({"session_id":"owned","after":ids[1],"presentation":true,"include_timestamps":true,"limit":3}));
    assert_eq!(second["rows"], json!([[ids[2],"tool_call",{"data":"2"},start+120_000],[ids[4],"text",{"data":"34"},start+180_000]]));
    let legacy = call(&host, json!({"session_id":"owned","presentation":true}));
    assert!(legacy["rows"].as_array().unwrap().iter().all(|row| row.as_array().unwrap().len() == 3));
    drop(host);
    let reopened = Host::open(&path).unwrap();
    assert_eq!(call(&reopened, params), first);
    assert_eq!(call(&reopened, json!({"session_id":"owned","after":ids[1],"presentation":true,"include_timestamps":true,"limit":3})), second);
}
