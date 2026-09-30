use octocode_host::protocol::{EventSequencer, Response, parse_request};
use serde_json::json;

#[test]
fn parses_requests_and_preserves_ids() {
    let request = parse_request(r#"{"id":"req-1","method":"ping","params":{"value":1}}"#).unwrap();
    assert_eq!(request.id, json!("req-1"));
    assert_eq!(request.method, "ping");
    assert_eq!(request.params, json!({ "value": 1 }));
}

#[test]
fn response_has_exactly_one_outcome() {
    let ok = Response::ok(json!(1), json!({ "status": "ok" }));
    assert!(ok.result.is_some());
    assert!(ok.error.is_none());

    let error = Response::error(json!(2), -32601, "method not found");
    assert!(error.result.is_none());
    assert_eq!(error.error.unwrap().code, -32601);
}

#[test]
fn event_sequences_are_monotonic() {
    let sequencer = EventSequencer::default();
    assert_eq!(sequencer.next("started", json!({})).sequence, 1);
    assert_eq!(sequencer.next("finished", json!({})).sequence, 2);
}

#[test]
fn malformed_input_is_rejected() {
    assert!(parse_request("not-json").is_err());
}
