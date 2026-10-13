//! Full loopback HTTP/SSE requests; no external provider or real credentials.
mod support;
use axum::{Router, http::StatusCode, response::IntoResponse, routing::post};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use xai_grok_sampler::SamplingClient;
use xai_grok_sampling_types::{ChatCompletionRequest, SamplingError};

struct Mock {
    url: String,
    bodies: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(status: u16, error: Value, rejected: Option<&'static str>) -> Mock {
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = bodies.clone();
    let app = Router::new().route("/v1/chat/completions", post(move |body: String| {
        let sink = sink.clone(); let error = error.clone();
        async move {
            let body: Value = serde_json::from_str(&body).unwrap();
            let mut seen = sink.lock().unwrap();
            let fail = rejected.map_or(seen.is_empty(), |p| body.pointer(p).is_some());
            seen.push(body.clone()); drop(seen);
            if fail { return (StatusCode::from_u16(status).unwrap(), [("retry-after","7"),("x-should-retry","false"),("x-grok-context-window","8192")], error.to_string()).into_response(); }
            if body["stream"] == true {
                return ([("content-type", "text/event-stream")], "data: {\"id\":\"owned\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"test-model\",\"choices\":[]}\n\ndata: [DONE]\n\n").into_response();
            }
            (StatusCode::OK, json!({"id":"owned","object":"chat.completion","created":1,"model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":"FIXTURE_OK"},"finish_reason":"stop"}]}).to_string()).into_response()
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Mock { url, bodies, task }
}
fn client(mock: &Mock, thinking: bool) -> SamplingClient {
    let mut cfg = support::test_config(&mock.url, "owned-fixture-not-a-secret");
    cfg.extra_body = Some(
        json!({"response_format":{"type":"json_object"},"seed":17,"model":"must-not-win","chat_template_kwargs":{"custom_template_option":"required"}}),
    );
    if thinking {
        cfg.extra_body.as_mut().unwrap()["chat_template_kwargs"]["enable_thinking"] = json!(true);
        cfg.extra_body.as_mut().unwrap()["thinking_budget"] = json!(2048);
        cfg.extra_body.as_mut().unwrap()["chat_template_kwargs"]["thinking_budget"] = json!(128);
        cfg.extra_body.as_mut().unwrap()["thinking"] =
            json!({"type":"enabled","budget_tokens":1024});
    }
    SamplingClient::new(cfg).unwrap()
}
async fn send(
    client: &SamplingClient,
    thinking: bool,
    streaming: bool,
) -> Result<(), SamplingError> {
    let mut body = json!({"messages":[{"role":"user","content":"owned fixture"}]});
    if thinking {
        body["reasoning_effort"] = json!("high");
    }
    let request: ChatCompletionRequest = serde_json::from_value(body).unwrap();
    if streaming {
        let (mut stream, _) = client.chat_completion_stream(request).await?;
        let mut count = 0;
        while let Some(chunk) = stream.next().await {
            chunk?;
            count += 1;
        }
        assert_eq!(count, 1);
    } else {
        assert_eq!(
            client.chat_completion(request).await?.choices[0]
                .message
                .content
                .as_deref(),
            Some("FIXTURE_OK")
        );
    }
    Ok(())
}
#[tokio::test]
async fn unrelated_errors_do_not_retry_or_poison_later_requests() {
    for streaming in [false, true] {
        for (status, error) in [
            (
                400,
                json!({"error":{"message":"context length exceeded","code":"context_length_exceeded"}}),
            ),
            (
                422,
                json!({"error":{"message":"invalid response_format","param":"response_format","code":"invalid_parameter"}}),
            ),
            (400, json!({"error":{"message":"unknown field"}})),
            (
                400,
                json!({"error":{"message":"unknown field response_format; reasoning_effort was supplied"}}),
            ),
            (
                400,
                json!({"error":{"message":"reasoning_effort value must be low or high","param":"reasoning_effort","code":"invalid_value"}}),
            ),
            (
                500,
                json!({"error":{"message":"unsupported parameter: reasoning_effort","param":"reasoning_effort","code":"unsupported_parameter"}}),
            ),
        ] {
            let expected_message = error["error"]["message"].as_str().unwrap().to_owned();
            let expected_code = error["error"]["code"].as_str().map(str::to_owned);
            let mock = server(status, error, None).await;
            let client = client(&mock, true);
            match send(&client, true, streaming).await.unwrap_err() {
                SamplingError::Api {
                    status: actual,
                    message,
                    retry_after_secs,
                    should_retry,
                    model_metadata,
                    error_code,
                } => {
                    assert_eq!(actual.as_u16(), status);
                    assert!(message.contains(&expected_message));
                    assert_eq!(retry_after_secs, Some(7));
                    assert_eq!(should_retry, Some(false));
                    assert_eq!(model_metadata.unwrap().context_window, Some(8192));
                    assert_eq!(
                        error_code.as_ref().map(|c| c.as_str()),
                        expected_code.as_deref()
                    );
                }
                error => panic!("expected preserved API error: {error:?}"),
            }
            assert_eq!(mock.bodies.lock().unwrap().len(), 1);
            send(&client, true, streaming).await.unwrap();
            let bodies = mock.bodies.lock().unwrap();
            assert_eq!(bodies.len(), 2);
            assert_eq!(bodies[0], bodies[1]);
        }
    }
}
#[tokio::test]
async fn unsupported_controls_are_removed_individually_and_stay_removed() {
    for streaming in [false, true] {
        for (status, error, pointer) in [
            (
                400,
                json!({"error":{"message":"parameter unavailable","param":"reasoning_effort","code":"unsupported_parameter"}}),
                "/reasoning_effort",
            ),
            (
                422,
                json!({"detail":[{"type":"extra_forbidden","loc":["body","chat_template_kwargs","enable_thinking"],"msg":"Extra inputs are not permitted"}]}),
                "/chat_template_kwargs/enable_thinking",
            ),
            (
                400,
                json!({"error":{"message":"unknown field `thinking_budget`"}}),
                "/thinking_budget",
            ),
            (
                400,
                json!({"error":{"message":"unknown field `chat_template_kwargs`"}}),
                "/chat_template_kwargs",
            ),
            (
                422,
                json!({"detail":[{"type":"extra_forbidden","loc":["body","chat_template_kwargs","thinking_budget"],"msg":"Extra inputs are not permitted"}]}),
                "/chat_template_kwargs/thinking_budget",
            ),
            (
                400,
                json!({"error":{"message":"unsupported parameter: thinking"}}),
                "/thinking",
            ),
        ] {
            let mock = server(status, error, Some(pointer)).await;
            let client = client(&mock, true);
            send(&client, true, streaming).await.unwrap();
            send(&client, true, streaming).await.unwrap();
            let bodies = mock.bodies.lock().unwrap();
            assert_eq!(bodies.len(), 3);
            for retry in &bodies[1..] {
                assert!(retry.pointer(pointer).is_none());
                assert_eq!(retry["seed"], 17);
                assert_eq!(retry["response_format"], json!({"type":"json_object"}));
                assert_eq!(retry["model"], "test-model");
                if pointer != "/reasoning_effort" {
                    assert_eq!(retry["reasoning_effort"], "high");
                }
                if pointer != "/thinking_budget" {
                    assert_eq!(retry["thinking_budget"], 2048);
                }
                if pointer != "/chat_template_kwargs" {
                    assert_eq!(
                        retry["chat_template_kwargs"]["custom_template_option"],
                        "required"
                    );
                }
            }
        }
    }
}
#[tokio::test]
async fn non_thinking_extras_cannot_trigger_thinking_retry() {
    for streaming in [false, true] {
        for error in [
            json!({"error":{"message":"unknown field seed"}}),
            json!({"error":{"code":"unsupported_parameter","param":"reasoning_effort","message":"unsupported parameter: reasoning_effort"}}),
            json!({"error":{"message":"unknown field chat_template_kwargs"}}),
        ] {
            let mock = server(400, error, None).await;
            let client = client(&mock, false);
            assert!(send(&client, false, streaming).await.is_err());
            assert_eq!(mock.bodies.lock().unwrap().len(), 1);
            send(&client, false, streaming).await.unwrap();
            assert_eq!(mock.bodies.lock().unwrap().len(), 2);
        }
    }
}

#[tokio::test]
async fn repeated_rejection_after_field_removal_returns_error_without_looping() {
    for streaming in [false, true] {
        let mock = server(
            400,
            json!({"error":{"message":"unknown field reasoning_effort"}}),
            Some("/seed"),
        )
        .await;
        let client = client(&mock, true);
        assert!(matches!(
            send(&client, true, streaming).await,
            Err(SamplingError::Api { .. })
        ));
        let bodies = mock.bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        assert!(bodies[0].get("reasoning_effort").is_some());
        assert!(bodies[1].get("reasoning_effort").is_none());
        assert_eq!(bodies[1]["seed"], 17);
    }
}
