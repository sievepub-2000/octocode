use octocode_host::supervisor::{Observer, StreamRule, compile_rules};
use serde_json::json;
use std::collections::HashSet;

fn rules() -> Vec<octocode_host::supervisor::CompiledRule> {
    let rules: Vec<StreamRule> = serde_json::from_value(json!([
        {"id":"first","scope":"text","pattern":"owned first","message":"first correction"},
        {"id":"second","scope":"text","pattern":"owned second","message":"second correction"},
        {"id":"tool","scope":"tool_input","pattern":"owned-danger","message":"tool correction"}
    ])).unwrap();
    compile_rules(&rules).unwrap()
}

#[test]
fn gated_observation_preserves_records_without_consuming_rule_keys() {
    let rules = rules(); let mut fired = HashSet::new();
    {
        let mut observer = Observer::new(&rules, &mut fired);
        assert!(observer.observe_with_interventions("text", &json!({"data":"owned second"}), false).is_none());
        assert_eq!(observer.final_text, "owned second");
        assert!(observer.observe_with_interventions("tool_call", &json!({"toolName":"owned-danger","rawInput":{}}), false).is_none());
        observer.observe_with_interventions("tool_call_update", &json!({"status":"failed"}), false);
        observer.observe_with_interventions("error", &json!({"message":"owned HTTP 502"}), false);
        observer.observe_with_interventions("text", &json!({"data":"owned final"}), false);
        assert_eq!(observer.tool_calls, 1);
        assert!(observer.tool_log[0].ends_with(" -> failed"));
        assert_eq!(observer.final_text, "owned final");
        assert_eq!(observer.last_error.as_deref(), Some("owned HTTP 502"));
    }
    assert!(fired.is_empty());
    let mut next = Observer::new(&rules, &mut fired);
    assert!(next.observe("text", &json!({"data":"owned second"})).is_some());
    assert!(next.observe("tool_call", &json!({"toolName":"owned-danger","rawInput":{}})).is_some());
}

#[test]
fn disabled_stall_checks_record_calls_but_leave_next_attempt_stall_available() {
    let rules = rules(); let mut fired = HashSet::new(); let call = json!({"toolName":"owned-safe","rawInput":{}});
    {
        let mut observer = Observer::new(&rules, &mut fired);
        for _ in 0..4 { assert!(observer.observe_with_interventions("tool_call", &call, false).is_none()); }
        assert_eq!(observer.tool_calls, 4); assert_eq!(observer.tool_log.len(), 4);
    }
    assert!(fired.is_empty());
    let mut next = Observer::new(&rules, &mut fired);
    assert!(next.observe("tool_call", &call).is_none());
    assert!(next.observe("tool_call", &call).is_none());
    assert!(next.observe("tool_call", &call).is_some());
}

#[test]
fn delivered_rule_stays_suppressed_while_unsent_second_rule_remains_available() {
    let rules = rules(); let mut fired = HashSet::new();
    {
        let mut observer = Observer::new(&rules, &mut fired);
        assert!(observer.observe("text", &json!({"data":"owned first"})).is_some());
        assert!(observer.observe_with_interventions("text", &json!({"data":"owned second"}), false).is_none());
    }
    assert!(fired.contains("first")); assert!(!fired.contains("second"));
    let mut next = Observer::new(&rules, &mut fired);
    assert!(next.observe("text", &json!({"data":"owned first"})).is_none());
    assert!(next.observe("text", &json!({"data":"owned second"})).is_some());
}
