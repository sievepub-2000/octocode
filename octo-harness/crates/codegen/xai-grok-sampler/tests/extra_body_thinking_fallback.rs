//! `extra_body` reaches chat/completions requests, and a server that rejects the
//! thinking controls degrades to plain requests instead of failing the task.

mod support;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::StatusCode;
use axum::routing::post;
use tokio::net::TcpListener;
use xai_grok_sampler::SamplingClient;
use xai_grok_sampling_types::ReasoningEffort;

async fn server(reject_thinking: bool) -> (String, Arc<Mutex<Vec<serde_json::Value>>>) {
    let bodies: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = Arc::clone(&bodies);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let sink = Arc::clone(&sink);
            async move {
                let json: serde_json::Value = serde_json::from_str(&body).unwrap();
                let thinking = json.get("chat_template_kwargs").is_some()
                    || json.get("reasoning_effort").is_some();
                let rejected = if json.get("chat_template_kwargs").is_some() {
                    "chat_template_kwargs"
                } else { "reasoning_effort" };
                sink.lock().unwrap().push(json);
                if reject_thinking && thinking {
                    (
                        StatusCode::BAD_REQUEST,
                        serde_json::json!({"error":{"message":format!("unknown field `{rejected}`")}}).to_string(),
                    )
                } else {
                    (StatusCode::OK, "{}".to_string())
                }
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/v1"), bodies)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn extra_body_is_merged_without_overriding_typed_fields() {
    let (base_url, bodies) = server(false).await;
    let mut cfg = support::test_config(&base_url, "k");
    cfg.extra_body = Some(serde_json::json!({
        "chat_template_kwargs": {"enable_thinking": true},
        "thinking_budget": 2048,
        "model": "must-not-win"
    }));
    let client = SamplingClient::new(cfg).expect("client builds");
    support::send_one(&client).await;

    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["chat_template_kwargs"]["enable_thinking"], true);
    assert_eq!(bodies[0]["thinking_budget"], 2048);
    assert_eq!(bodies[0]["model"], "test-model");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_thinking_controls_fall_back_to_plain_requests_and_stay_off() {
    let (base_url, bodies) = server(true).await;
    let mut cfg = support::test_config(&base_url, "k");
    cfg.extra_body = Some(serde_json::json!({"chat_template_kwargs": {"enable_thinking": true}}));
    cfg.reasoning_effort = Some(ReasoningEffort::High);
    let client = SamplingClient::new(cfg).expect("client builds");

    support::send_one(&client).await;
    support::send_one(&client).await;

    let bodies = bodies.lock().unwrap();
    // This conversation fixture sends the template control; only that named
    // rejection is retried. The direct-request wire suite covers effort too.
    assert_eq!(bodies.len(), 3, "{bodies:#?}");
    assert!(bodies[0].get("chat_template_kwargs").is_some());
    for plain in &bodies[1..] {
        assert!(plain.get("chat_template_kwargs").is_none(), "{plain}");
        assert!(plain.get("reasoning_effort").is_none(), "{plain}");
    }
}
