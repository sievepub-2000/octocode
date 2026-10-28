use octocode_host::{host::Host, protocol::Request};
use serde_json::{Value, json};

fn page(host: &Host, include: bool) -> Value {
    host.dispatch(Request { id:json!(1), method:"event.page".into(), params:json!({"session_id":"owned","presentation":true,"include_timestamps":include}) }).result.unwrap()
}

#[test]
fn timestamp_presentation_retains_split_tag_and_answer_source_times_only_when_requested() {
    let host = Host::open(":memory:").unwrap();
    host.dispatch(Request { id:json!(1), method:"session.create".into(), params:json!({"id":"owned","title":"owned"}) }).result.unwrap();
    for (index, data) in ["<oc", "to_thought>thinking", "</octo_th", "ought>", "😊 answer", " continued"].into_iter().enumerate() {
        host.record_event_at("owned", "text", &json!({"data":data}), 1000 + index as i64 * 1000).unwrap();
    }
    let timestamped = page(&host, true);
    let rows = timestamped["rows"].as_array().unwrap();
    assert_eq!(rows.last().unwrap()[2]["data"], "😊 answer continued");
    assert_eq!(rows.last().unwrap()[3], 5000, "new answer must retain its own source time");
    let original = page(&host, false);
    assert_eq!(original["rows"].as_array().unwrap().len(), 1, "default compression is unchanged");
    assert_eq!(original["rows"][0].as_array().unwrap().len(), 3);
}
