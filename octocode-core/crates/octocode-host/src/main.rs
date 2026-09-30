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
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    let agents = AgentManager::default();
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();

    loop {
        tokio::select! {
            line = lines.next_line() => match line? {
                Some(line) => {
                    let response = match parse_request(&line) {
                        Ok(request) => {
                            let method = request.method.clone();
                            let params = request.params.clone();
                            let started = Instant::now();
                            let response = handle_request(&host, &agents, &events_tx, request);
                            if method != "log.create" {
                                host.record_rpc(&method, &params, &response, started.elapsed().as_millis());
                            }
                            response
                        },
                        Err(error) => Response::error(serde_json::Value::Null, -32700, error.to_string()),
                    };
                    write_json(&mut stdout, &response).await?;
                }
                None => break,
            },
            Some(event) = events_rx.recv() => {
                if matches!(event.kind.as_str(), "agent.started" | "agent.finished" | "agent.error") {
                    host.record_agent_lifecycle(
                        &event.task_id,
                        &event.session_id,
                        &event.kind,
                        &event.payload,
                    )?;
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
                if let Err(error) = host.record_event(&event.session_id, &event.kind, &event.payload) {
                    let failure = AgentEvent {
                        task_id: event.task_id.clone(), session_id: event.session_id.clone(),
                        kind: "agent.persistence_error".into(), payload: json!({"message": error.to_string()}),
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
    request: Request,
) -> Response {
    match request.method.as_str() {
        "agent.run" => match serde_json::from_value::<AgentRun>(request.params) {
            Ok(run) => match (|| {
                host.validate_agent_task(&run.task_id, &run.session_id)?;
                agents.start(run, events.clone())
            })() {
                Ok(task_id) => Response::ok(request.id, json!({"task_id": task_id})),
                Err(error) => Response::error(request.id, -32010, error.to_string()),
            },
            Err(error) => Response::error(request.id, -32602, error.to_string()),
        },
        "agent.steer" => {
            let task_id = request.params.get("task_id").and_then(serde_json::Value::as_str).unwrap_or("");
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
