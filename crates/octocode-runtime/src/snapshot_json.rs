use octocode_core::{RuntimeEvent, UiSnapshot};

pub(crate) fn snapshot_to_json(snapshot: &UiSnapshot) -> String {
    serde_json::to_string(snapshot).unwrap_or_else(|e| {
        format!("{{\"error\":\"serialization failed: {}\"}}", e)
    })
}

pub(crate) fn runtime_event_to_json(event: &RuntimeEvent) -> String {
    serde_json::to_string(event).unwrap_or_else(|e| {
        format!("{{\"error\":\"serialization failed: {}\"}}", e)
    })
}
