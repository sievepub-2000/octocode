use octocode_host::{
    agent::{AgentEvent, AgentManager, AgentRun},
    host::Host,
    protocol::{Request, Response, parse_request},
};
use serde::Serialize;
use serde_json::json;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = Host::open(database_path()?)?;
    let mut input = BufReader::new(tokio::io::stdin());
    // read_until is cancellation-safe; keep partial bytes across agent events.
    let mut line = Vec::new();
    let mut stdout = tokio::io::stdout();
    let agents = AgentManager::default();
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();

    loop {
        tokio::select! {
            count = input.read_until(b'\n', &mut line) => {
                    if count? == 0 && line.is_empty() { break; }
                    let parsed = std::str::from_utf8(&line)
                        .map_err(|error| error.to_string())
                        .and_then(|text| parse_request(text).map_err(|error| error.to_string()));
                    line.clear();
                    let response = match parsed {
                        Ok(request) => {
                            let method = request.method.clone();
                            let params = request.params.clone();
                            let started = Instant::now();
                            let response = handle_request(&host, &agents, &events_tx, &events_rx, request);
                            if method != "log.create" {
                                host.record_rpc(&method, &params, &response, started.elapsed().as_millis());
                            }
                            response
                        },
                        Err(error) => Response::error(serde_json::Value::Null, -32700, error.to_string()),
                    };
                    write_json(&mut stdout, &response).await?;
            },
            Some(event) = events_rx.recv() => {
                if matches!(event.kind.as_str(), "agent.started" | "agent.finished" | "agent.error") {
                    if let Err(error) = host.record_agent_lifecycle(
                        &event.task_id,
                        &event.session_id,
                        &event.kind,
                        &event.payload,
                    ) {
                        let failure = AgentEvent {
                            task_id: event.task_id.clone(), session_id: event.session_id.clone(),
                            kind: "agent.persistence_error".into(),
                            payload: json!({"message": error.to_string(), "operation": "lifecycle"}),
                            created_at: chrono::Utc::now().timestamp_millis(),
                        };
                        write_json(&mut stdout, &failure).await?;
                    }
                }
                let level = if event.kind == "agent.error" || event.kind == "agent.stderr" { "error" } else { "info" };
                let message = event.payload.get("message").or_else(|| event.payload.get("text"))
                    .and_then(serde_json::Value::as_str)
                    .map(|value| value.chars().take(4000).collect::<String>())
                    .unwrap_or_else(|| event.kind.clone());
                // Token deltas already live in the event audit. Do not duplicate
                // each token as a searchable operational log entry.
                if !matches!(event.kind.as_str(), "thought" | "text" | "tool_call_update") {
                host.record_log(
                    level,
                    "agent",
                    &message,
                    &json!({"task_id": event.task_id, "event_kind": event.kind}),
                    Some(&event.session_id),
                );
                }
                if let Err(error) = host.record_event_at(&event.session_id, &event.kind, &event.payload, event.created_at) {
                    let failure = AgentEvent {
                        task_id: event.task_id.clone(), session_id: event.session_id.clone(),
                        kind: "agent.persistence_error".into(), payload: json!({"message": error.to_string()}),
                        created_at: chrono::Utc::now().timestamp_millis(),
                    };
                    write_json(&mut stdout, &failure).await?;
                }
                write_json(&mut stdout, &event).await?;
            }
        }
    }
    Ok(())
}

fn handle_request(
    host: &Host,
    agents: &AgentManager,
    events: &tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    pending: &tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    request: Request,
) -> Response {
    match request.method.as_str() {
        "session.delete" if request.params.get("expected_unstarted_task").is_some() => {
            let id = request.params.get("id").and_then(serde_json::Value::as_str);
            let task = request.params.get("expected_unstarted_task").and_then(serde_json::Value::as_str);
            if !id.is_some_and(|id| !id.trim().is_empty()) || !task.is_some_and(|task| !task.trim().is_empty()) {
                return Response::error(request.id, -32602, "guarded deletion requires session id and expected_unstarted_task");
            }
            match agents.active_session(id.unwrap()) {
                Err(error) => Response::error(request.id, -32010, error.to_string()),
                Ok(true) => Response::ok(request.id, json!({"deleted":false})),
                // Read the queue only AFTER the ownership lock observation. Producers
                // send final events before releasing their slot. Never consume here.
                Ok(false) if !pending.is_empty() => Response::ok(request.id, json!({"deleted":false})),
                Ok(false) => host.dispatch(request),
            }
        }
        "agent.run" => match serde_json::from_value::<AgentRun>(request.params) {
            Ok(run) => match (|| {
                host.validate_agent_task(&run.task_id, &run.session_id)?;
                host.validate_agent_working_directory(&run.session_id, &run.cwd)?;
                agents.start(run, events.clone())
            })() {
                Ok(task_id) => Response::ok(request.id, json!({"task_id": task_id})),
                Err(error) => Response::error(request.id, -32010, error.to_string()),
            },
            Err(error) => Response::error(request.id, -32602, error.to_string()),
        },
        "agent.steer" => {
            let Some(task_id) = request.params.get("task_id")
                .and_then(serde_json::Value::as_str).filter(|id| !id.is_empty()) else {
                return Response::error(request.id, -32602, "task_id must be a nonempty string");
            };
            match agents.steer(task_id, request.params.clone()) {
                Ok(()) => Response::ok(request.id, json!({"queued": true})),
                Err(error) => Response::error(request.id, -32010, error.to_string()),
            }
        }
        "agent.cancel" => {
            let task_id = request
                .params
                .get("task_id")
                .and_then(serde_json::Value::as_str);
            match task_id {
                Some(task_id) => {
                    Response::ok(request.id, json!({"cancelled": agents.cancel(task_id)}))
                }
                None => Response::error(request.id, -32602, "task_id is required"),
            }
        }
        _ => host.dispatch(request),
    }
}

async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> anyhow::Result<()> {
    writer
        .write_all(serde_json::to_string(value)?.as_bytes())
        .await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

fn database_path() -> anyhow::Result<std::path::PathBuf> {
    let mut args = std::env::args_os().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some(flag), Some(path)) if flag == "--db" => Ok(path.into()),
        _ => anyhow::bail!("usage: octocode-host --db <path>"),
    }
}

#[cfg(test)]
mod steer_validation_tests {
    use super::*;

    #[test]
    fn agent_run_rejects_another_conversations_directory() {
        let dir = tempfile::tempdir().unwrap();
        let host = Host::open(dir.path().join("owned.db")).unwrap();
        let agents = AgentManager::default();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let prepared = host.dispatch(Request { id: json!(1), method: "harness.prepare".into(), params: json!({
            "title":"owned", "prompt":"owned", "workspace":dir.path(),
            "provider":{"apiProvider":"openai","openAiModelId":"owned"}
        }) }).result.unwrap();
        let response = handle_request(&host, &agents, &tx, &rx, Request { id:json!(2), method:"agent.run".into(), params:json!({
            "task_id":prepared["task_id"], "session_id":prepared["session_id"],
            "executable":dir.path().join("missing.exe"), "cwd":dir.path(), "harness_home":dir.path(), "prompt":"owned",
            "model":{"model":"owned","base_url":"http://127.0.0.1:9","api_key":"","api_backend":"chat_completions","context_window":65536,"max_completion_tokens":1000}
        }) });
        assert!(response.error.unwrap().message.contains("different conversation"));
        assert!(rx.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn valid_reserved_task_preserves_queued_result_without_model_execution() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("owned-invalid.exe");
        std::fs::write(&exe, b"owned invalid executable, no model").unwrap();
        let host = Host::open(dir.path().join("owned.db")).unwrap();
        let agents = AgentManager::default();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let run: AgentRun = serde_json::from_value(json!({"task_id":"owned-task", "session_id":"owned-session",
            "executable":exe,"cwd":dir.path(),"harness_home":dir.path(),"prompt":"owned",
            "model":{"model":"owned","base_url":"http://127.0.0.1:9","api_key":"","api_backend":"chat_completions","context_window":65536,"max_completion_tokens":1000}})).unwrap();
        agents.start(run, tx.clone()).unwrap();
        // No await before steering: the owned task slot is reserved but its
        // spawned future has not run on this single-thread executor.
        let response = handle_request(&host, &agents, &tx, &rx, Request { id:json!(1),method:"agent.steer".into(),params:json!({"task_id":"owned-task","id":"owned-message","text":"owned"}) });
        assert!(response.error.is_none());
        assert_eq!(response.result.unwrap(), json!({"queued":true}));
        assert!(agents.cancel("owned-task"));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while agents.active_session("owned-session").unwrap() { tokio::task::yield_now().await; }
        }).await.unwrap();
    }

    #[test]
    fn invalid_task_ids_are_parameter_errors_and_valid_unknown_ids_keep_agent_errors() {
        let dir = tempfile::tempdir().unwrap();
        let host = Host::open(dir.path().join("owned.db")).unwrap();
        let agents = AgentManager::default();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        for value in [None, Some(json!(null)), Some(json!(false)), Some(json!(1)), Some(json!([])), Some(json!({})), Some(json!("")), Some(json!("owned-missing")), Some(json!(" "))] {
            let mut params = json!({"id":"owned-message", "text":"owned"});
            if let Some(value) = &value { params["task_id"] = value.clone(); }
            let valid = value.as_ref().and_then(serde_json::Value::as_str).is_some_and(|id| !id.is_empty());
            let response = handle_request(&host, &agents, &tx, &rx, Request { id:json!(1), method:"agent.steer".into(), params });
            assert!(response.result.is_none());
            assert_eq!(response.error.unwrap().code, if valid { -32010 } else { -32602 }, "{value:?}");
            assert!(rx.is_empty());
        }
    }
}

#[cfg(test)]
mod guarded_delete_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn reserved_cancelling_then_ended_queued_slot_refuses_actual_handler() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("not-an-executable.exe");
        std::fs::write(&exe, b"owned invalid executable; no model").unwrap();
        let host = Host::open(dir.path().join("owned.db")).unwrap();
        let agents = AgentManager::default();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let p = host.dispatch(Request { id:json!(1),method:"harness.prepare".into(),params:json!({"title":"owned","prompt":"owned","provider":{"apiProvider":"openai","openAiModelId":"owned"}}) }).result.unwrap();
        let session=p["session_id"].as_str().unwrap(); let task=p["task_id"].as_str().unwrap();
        let run: AgentRun=serde_json::from_value(json!({"task_id":task,"session_id":session,
            "executable":exe,"cwd":dir.path(),"harness_home":dir.path(),"prompt":"owned",
            "model":{"model":"owned","base_url":"http://127.0.0.1:9","api_key":"","api_backend":"chat_completions","context_window":65536,"max_completion_tokens":1000}})).unwrap();
        agents.start(run,tx.clone()).unwrap();
        let request=|| Request{id:json!(2),method:"session.delete".into(),params:json!({"id":session,"expected_unstarted_task":task})};
        assert!(agents.active_session(session).unwrap()); assert!(rx.is_empty());
        assert_eq!(handle_request(&host,&agents,&tx,&rx,request()).result.unwrap()["deleted"],false);
        assert!(agents.cancel(task));
        assert!(agents.active_session(session).unwrap());
        assert_eq!(handle_request(&host,&agents,&tx,&rx,request()).result.unwrap()["deleted"],false);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while agents.active_session(session).unwrap() { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert!(!rx.is_empty()); let pending_count=rx.len();
        assert_eq!(handle_request(&host,&agents,&tx,&rx,request()).result.unwrap()["deleted"],false);
        assert_eq!(rx.len(),pending_count);
        assert!(!host.dispatch(Request{id:json!(3),method:"session.get".into(),params:json!({"id":session})}).result.unwrap().is_null());
    }

    #[test]
    fn queued_events_refuse_without_consuming_and_empty_queue_allows_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let host = Host::open(dir.path().join("owned.db")).unwrap();
        let agents = AgentManager::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let prepared = host.dispatch(Request { id: json!(1), method: "harness.prepare".into(), params: json!({
            "title":"owned", "prompt":"owned", "provider":{"apiProvider":"openai", "openAiModelId":"owned"}
        }) }).result.unwrap();
        let session = prepared["session_id"].as_str().unwrap();
        let task = prepared["task_id"].as_str().unwrap();
        let request = || Request { id: json!(2), method: "session.delete".into(), params: json!({"id":session,"expected_unstarted_task":task}) };
        // Real channel and handler, controlled producer completion, no agent/model.
        for (session_id, kind) in [(session, "agent.started"), (session, "agent.finished"), ("other", "agent.started")] {
            let producer = tx.clone();
            producer.send(AgentEvent { session_id:session_id.into(), task_id:task.into(), kind:kind.into(), payload:json!({}), created_at:chrono::Utc::now().timestamp_millis() }).unwrap();
            drop(producer);
            assert!(!agents.active_session(session).unwrap());
            assert_eq!(handle_request(&host, &agents, &tx, &rx, request()).result.unwrap()["deleted"], false);
            assert_eq!(rx.len(), 1);
            let retained = rx.try_recv().unwrap();
            assert_eq!(retained.kind, kind);
            assert_eq!(retained.session_id, session_id);
        }
        assert_eq!(handle_request(&host, &agents, &tx, &rx, request()).result.unwrap()["deleted"], true);
    }
}
