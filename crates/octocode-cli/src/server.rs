use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use octocode_api::{BuiltinProvider, ProviderRegistry};
use octocode_commands::{execute_command, CliCommand};
use octocode_core::{OctoError, PermissionMode, PlatformSupport, ProviderFactory, RuntimeConfig, ToolCall};
use octocode_runtime::{
    ConfigLoader, FileSessionStore, NativePlatform, OctocodeRuntime, RuntimeProviderRouter,
    WorkspaceToolExecutor,
};

pub type AppRuntime = OctocodeRuntime<RuntimeProviderRouter<BuiltinProvider>, FileSessionStore, WorkspaceToolExecutor>;

const TOKEN_HEADER: &str = "x-octocode-token";
const AUDIT_FILE_NAME: &str = "high-permission.log";

pub fn build_runtime(
    workspace_root: String,
    config: RuntimeConfig,
) -> Result<AppRuntime, Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(workspace_root);
    let registry = ProviderRegistry::new();
    let store = FileSessionStore::new(&platform.config_paths())?;
    Ok(OctocodeRuntime::new(
        RuntimeProviderRouter::from_factory(&registry, &config)?,
        store,
        WorkspaceToolExecutor::with_shell(
            platform.context().root.clone(),
            platform.context().preferred_shell.clone(),
        ),
        platform.context().clone(),
        registry.descriptors().to_vec(),
    ))
}

pub fn run_server(
    port: u16,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("Octocode WebUI ready on port {port}");
    if std::env::var("OCTOCODE_TOKEN").ok().filter(|value| !value.is_empty()).is_some() {
        println!("Octocode local API token enforcement is enabled via OCTOCODE_TOKEN");
    }

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(error) = handle_connection(stream, initial_session_id.clone()) {
                    eprintln!("server error: {error}");
                }
            }
            Err(error) => eprintln!("accept error: {error}"),
        }
    }

    Ok(())
}

fn handle_connection(
    mut stream: TcpStream,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let request = read_http_request(&mut stream)?;
    let response = route_request(&request, initial_session_id)?;
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn route_request(
    request: &HttpRequest,
    initial_session_id: Option<String>,
) -> Result<String, Box<dyn std::error::Error>> {
    let workspace_root = String::from(".");
    let platform = NativePlatform::detect(workspace_root.clone());
    let paths = platform.config_paths();
    let loader = ConfigLoader::new(paths.clone());
    let config = loader.load()?;

    if request.path.starts_with("/api/") {
        verify_local_api_request(request)?;
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Ok(http_redirect("/ui-shell/")),
        ("GET", "/api/state") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.snapshot_json(session_id.as_deref())?)
        }
        ("GET", "/api/events") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.event_feed_json(session_id.as_deref())?)
        }
        ("GET", "/api/timeline") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.event_feed_json(session_id.as_deref())?)
        }
        ("GET", "/api/health") => {
            let runtime = build_runtime(workspace_root, config)?;
            let body = runtime
                .provider_healths()
                .into_iter()
                .map(|health| {
                    format!(
                        concat!(
                            "{{",
                            "\"providerId\":\"{}\",",
                            "\"displayName\":\"{}\",",
                            "\"healthy\":{},",
                            "\"detail\":\"{}\",",
                            "\"model\":\"{}\",",
                            "\"latencyMs\":{}",
                            "}}"
                        ),
                        escape_json(&health.provider_id),
                        escape_json(&health.display_name),
                        health.healthy,
                        escape_json(&health.detail),
                        escape_json(health.model.as_deref().unwrap_or("")),
                        health
                            .latency_ms
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| String::from("null"))
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            json_response(format!("{{\"items\":[{}]}}", body))
        }
        ("GET", "/api/audit") => {
            let body = read_audit_json(&paths.data_home)?;
            json_response(body)
        }
        ("POST", "/api/chat") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let text = request.form_value("text").unwrap_or_default();
            let runtime = build_runtime(workspace_root, config)?;
            let result = runtime.prompt_in_session(&session_id, &text);
            match result {
                Ok(_) => json_response(runtime.snapshot_json(Some(&session_id))?),
                Err(error) => error_response(500, &format!("chat failed: {error}")),
            }
        }
        ("POST", "/api/tool") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let name = request.form_value("name").unwrap_or_else(|| String::from("echo"));
            let input = request.form_value("input").unwrap_or_default();
            audit_tool_if_high_permission(&paths.data_home, &session_id, &name, &input)?;
            let runtime = build_runtime(workspace_root, config)?;
            let result = runtime.run_tool_in_session(
                &session_id,
                ToolCall {
                    name,
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            match result {
                Ok(_) => json_response(runtime.snapshot_json(Some(&session_id))?),
                Err(error) => error_response(500, &format!("tool failed: {error}")),
            }
        }
        ("POST", "/api/settings") => {
            let mut next = config.clone();
            if let Some(provider_id) = request.form_value("providerId") {
                if !provider_id.trim().is_empty() {
                    next.provider_id = Some(provider_id.trim().to_string());
                }
            }
            if let Some(provider_base_url) = request.form_value("providerBaseUrl") {
                if !provider_base_url.trim().is_empty() {
                    next.provider_base_url = Some(provider_base_url.trim().to_string());
                }
            }
            if let Some(default_model) = request.form_value("defaultModel") {
                if !default_model.trim().is_empty() {
                    next.default_model = Some(default_model.trim().to_string());
                }
            }
            if let Some(permission_mode) = request.form_value("permissionMode") {
                next.permission_mode = match permission_mode.trim() {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => {
                        append_high_permission_audit(
                            &paths.data_home,
                            "settings.permission",
                            "session=<settings> permission=danger-full-access",
                        )?;
                        PermissionMode::DangerFullAccess
                    }
                    _ => PermissionMode::WorkspaceWrite,
                };
            }
            if let Some(history_limit) = request.form_value("historyLimit") {
                next.history_limit = history_limit.parse::<usize>().unwrap_or(next.history_limit).max(1);
            }
            loader.save(&next)?;
            let runtime = build_runtime(workspace_root, next)?;
            let session_id = request.form_value("sessionId");
            json_response(runtime.snapshot_json(session_id.as_deref())?)
        }
        ("POST", "/api/command") => {
            let command = request.form_value("command").unwrap_or_default().trim().to_string();
            let session_id = request.form_value("sessionId");
            audit_command_if_high_permission(&paths.data_home, session_id.as_deref(), &command)?;
            handle_command(command, session_id, workspace_root, loader, config, paths.data_home)
        }
        _ => serve_static(request),
    }
}

fn verify_local_api_request(request: &HttpRequest) -> Result<(), Box<dyn std::error::Error>> {
    if !request.is_local_host_request() {
        return error_response(403, "forbidden: API Host must be localhost or 127.0.0.1").map(|_| ())
            .map_err(|_| OctoError::Runtime(String::from("forbidden: API Host must be localhost or 127.0.0.1")).into());
    }
    if !request.has_trusted_origin() {
        return Err(OctoError::Runtime(String::from(
            "forbidden: cross-origin Octocode API request rejected",
        ))
        .into());
    }
    if let Some(expected) = std::env::var("OCTOCODE_TOKEN").ok().filter(|value| !value.is_empty()) {
        let supplied = request
            .header(TOKEN_HEADER)
            .or_else(|| request.query_value("token"))
            .or_else(|| request.form_value("token"));
        if supplied.as_deref() != Some(expected.as_str()) {
            return Err(OctoError::Runtime(String::from(
                "forbidden: missing or invalid Octocode API token",
            ))
            .into());
        }
    }
    Ok(())
}

fn handle_command(
    command: String,
    session_id: Option<String>,
    workspace_root: String,
    loader: ConfigLoader,
    mut config: RuntimeConfig,
    data_home: String,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut parts = command.split_whitespace();
    let action = parts.next().unwrap_or_default();
    match action {
        "events" => {
            let runtime = build_runtime(workspace_root, config)?;
            return json_response(runtime.event_feed_json(session_id.as_deref())?);
        }
        "pipe" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let rest = parts.collect::<Vec<_>>().join(" ");
            let step_strs: Vec<&str> = rest.split(" | ").collect();
            let runtime = build_runtime(workspace_root, config)?;
            let mut step_summaries: Vec<String> = Vec::new();
            for step_raw in step_strs.iter() {
                let step_trim = step_raw.trim();
                if step_trim.is_empty() {
                    continue;
                }
                let mut sp = step_trim.splitn(2, ' ');
                let verb = sp.next().unwrap_or("echo");
                let input = sp.next().unwrap_or("").to_string();
                let tool_name_str = match verb {
                    "read" => "read-file",
                    "list" => "list-files",
                    "write" => "write-file",
                    "search" => "search-text",
                    _ => "echo",
                };
                if tool_name_str == "write-file" {
                    append_high_permission_audit(
                        &data_home,
                        "command.pipe.write",
                        &format!("session={} step={}", eff_session, step_trim),
                    )?;
                }
                let start = std::time::Instant::now();
                let _ = runtime.run_tool_in_session(
                    &eff_session,
                    ToolCall {
                        name: String::from(tool_name_str),
                        input: if input.is_empty() { String::from(".") } else { input.clone() },
                        permission: PermissionMode::ReadOnly,
                    },
                );
                let duration_ms = start.elapsed().as_millis();
                let mut step_obj = String::new();
                step_obj.push_str("{\"cmd\":\"");
                step_obj.push_str(&escape_json(step_trim));
                step_obj.push_str("\",\"tool\":\"");
                step_obj.push_str(tool_name_str);
                step_obj.push_str("\",\"durationMs\":");
                step_obj.push_str(&duration_ms.to_string());
                step_obj.push('}');
                step_summaries.push(step_obj);
            }
            let snapshot = runtime.snapshot_json(Some(&eff_session))?;
            let steps_json = format!("[{}]", step_summaries.join(","));
            let mut injected = String::with_capacity(snapshot.len() + steps_json.len() + 16);
            if snapshot.ends_with('}') {
                injected.push_str(&snapshot[..snapshot.len() - 1]);
                injected.push_str(",\"steps\":");
                injected.push_str(&steps_json);
                injected.push('}');
            } else {
                injected.push_str(&snapshot);
            }
            return json_response(injected);
        }
        "provider" => {
            if let Some(value) = parts.next() {
                config.provider_id = Some(String::from(value));
                loader.save(&config)?;
            }
        }
        "model" => {
            if let Some(value) = parts.next() {
                config.default_model = Some(String::from(value));
                loader.save(&config)?;
            }
        }
        "permission" | "approve" => {
            if let Some(value) = parts.next() {
                config.permission_mode = match value {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => {
                        append_high_permission_audit(
                            &data_home,
                            "command.permission",
                            &format!(
                                "session={} command={} value=danger-full-access",
                                session_id.as_deref().unwrap_or("<none>"),
                                action
                            ),
                        )?;
                        PermissionMode::DangerFullAccess
                    }
                    _ => PermissionMode::WorkspaceWrite,
                };
                loader.save(&config)?;
            }
        }
        "plan" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            runtime.run_tool_in_session(
                &session_id,
                ToolCall {
                    name: String::from("workflow-plan"),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "workflow" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let text = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            execute_command(
                &mut runtime,
                CliCommand::Workflow {
                    session_id: session_id.clone(),
                    text,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "agent" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let text = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            execute_command(
                &mut runtime,
                CliCommand::Agent {
                    session_id: session_id.clone(),
                    text,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "repl" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let text = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            execute_command(
                &mut runtime,
                CliCommand::Repl {
                    session_id: session_id.clone(),
                    text,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "snapshot" | "sessions" | "status" | "health" | "circuit-log" | "doctor" => {}
        "history" => {
            if let Some(value) = parts.next() {
                config.history_limit = value.trim().parse::<usize>().unwrap_or(config.history_limit).max(1);
                loader.save(&config)?;
            }
        }
        "read" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("read-file"),
                    input: if input.is_empty() { String::from("README.md") } else { input },
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "list" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("list-files"),
                    input: if input.is_empty() { String::from(".") } else { input },
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "write" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let remaining = parts.collect::<Vec<_>>();
            if remaining.len() < 2 {
                return error_response(400, "write requires: write <path> <content>");
            }
            let file_path = remaining[0].to_string();
            let content = remaining[1..].join(" ");
            append_high_permission_audit(
                &data_home,
                "command.write",
                &format!("session={} path={}", eff_session, file_path),
            )?;
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("write-file"),
                    input: format!("{file_path}|{content}"),
                    permission: PermissionMode::WorkspaceWrite,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "tool" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let tool_name = parts.next().unwrap_or("echo").to_string();
            let input = parts.collect::<Vec<_>>().join(" ");
            audit_tool_if_high_permission(&data_home, &eff_session, &tool_name, &input)?;
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: tool_name,
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "session-add" => {
            let new_id = parts.next().unwrap_or("session").to_string();
            let title = parts.collect::<Vec<_>>().join(" ");
            let mut runtime = build_runtime(workspace_root, config)?;
            let _ = execute_command(
                &mut runtime,
                CliCommand::SessionAdd {
                    id: new_id.clone(),
                    title: if title.is_empty() { String::from("Session") } else { title },
                },
            );
            return json_response(runtime.snapshot_json(Some(&new_id))?);
        }
        "session" => {
            let target = parts.next().map(String::from).or(session_id);
            let runtime = build_runtime(workspace_root, config)?;
            return json_response(runtime.snapshot_json(target.as_deref())?);
        }
        "search" => {
            let session_id = session_id.unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            runtime.run_tool_in_session(
                &session_id,
                ToolCall {
                    name: String::from("search-text"),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            return json_response(runtime.snapshot_json(Some(&session_id))?);
        }
        "git" => {
            let subcommand = parts.next().unwrap_or("status");
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let tool_name_str = match subcommand {
                "diff" => "git-diff",
                "log" => "git-log",
                _ => "git-status",
            };
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from(tool_name_str),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "context" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("read-context"),
                    input,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "tree" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let input = parts.collect::<Vec<_>>().join(" ");
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("file-tree"),
                    input: if input.is_empty() { String::from(". 3") } else { input },
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "tokens" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let runtime = build_runtime(workspace_root, config)?;
            let snapshot = runtime.snapshot_json(Some(&eff_session))?;
            let total_chars: usize = {
                let mut count = 0usize;
                let mut search = snapshot.as_str();
                while let Some(pos) = search.find("\"content\":\"") {
                    let after = &search[pos + 11..];
                    if let Some(end) = after.find('"') {
                        count += end;
                        search = &after[end + 1..];
                    } else {
                        break;
                    }
                }
                count
            };
            let token_estimate = total_chars / 4;
            let token_json = format!(
                "{{\"tokenEstimate\":{},\"charCount\":{},\"session\":\"{}\"}}",
                token_estimate, total_chars, escape_json(&eff_session)
            );
            let injected = if snapshot.ends_with('}') {
                let mut s = String::with_capacity(snapshot.len() + 64);
                s.push_str(&snapshot[..snapshot.len() - 1]);
                s.push_str(",\"tokenInfo\":");
                s.push_str(&token_json);
                s.push('}');
                s
            } else {
                snapshot
            };
            return json_response(injected);
        }
        "fetch" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let url = parts.collect::<Vec<_>>().join(" ");
            if url.is_empty() {
                return error_response(400, "fetch requires a URL");
            }
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("http-get"),
                    input: url,
                    permission: PermissionMode::ReadOnly,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "append" => {
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let remaining = parts.collect::<Vec<_>>();
            if remaining.is_empty() {
                return error_response(400, "append requires: append <path> <content>");
            }
            let file_path = remaining[0].to_string();
            let content = remaining[1..].join(" ");
            append_high_permission_audit(
                &data_home,
                "command.append",
                &format!("session={} path={}", eff_session, file_path),
            )?;
            let runtime = build_runtime(workspace_root, config)?;
            let _ = runtime.run_tool_in_session(
                &eff_session,
                ToolCall {
                    name: String::from("append-file"),
                    input: format!("{file_path}|{content}"),
                    permission: PermissionMode::WorkspaceWrite,
                },
            );
            return json_response(runtime.snapshot_json(Some(&eff_session))?);
        }
        "reload" | "refresh" | "" => {}
        _ => {
            return error_response(400, &format!("unsupported command: {command}"));
        }
    }

    let runtime = build_runtime(workspace_root, config)?;
    json_response(runtime.snapshot_json(session_id.as_deref())?)
}

fn audit_tool_if_high_permission(
    data_home: &str,
    session_id: &str,
    tool_name: &str,
    input: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let kind = match tool_name {
        "shell-command" => Some("tool.shell-command"),
        "write-file" => Some("tool.write-file"),
        "append-file" => Some("tool.append-file"),
        _ => None,
    };
    if let Some(kind) = kind {
        append_high_permission_audit(
            data_home,
            kind,
            &format!(
                "session={} tool={} input={}",
                session_id,
                tool_name,
                redact_for_audit(input)
            ),
        )?;
    }
    Ok(())
}

fn audit_command_if_high_permission(
    data_home: &str,
    session_id: Option<&str>,
    command: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let trimmed = command.trim();
    let high_risk = trimmed.starts_with("permission danger-full-access")
        || trimmed.starts_with("approve danger-full-access")
        || trimmed.starts_with("tool shell-command")
        || trimmed.starts_with("write ")
        || trimmed.starts_with("append ")
        || trimmed.contains(" | write ");
    if high_risk {
        append_high_permission_audit(
            data_home,
            "api.command",
            &format!(
                "session={} command={}",
                session_id.unwrap_or("<none>"),
                redact_for_audit(trimmed)
            ),
        )?;
    }
    Ok(())
}

fn append_high_permission_audit(
    data_home: &str,
    kind: &str,
    detail: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(data_home).join("audit");
    fs::create_dir_all(&dir)?;
    let path = dir.join(AUDIT_FILE_NAME);
    let line = format!(
        "{}\t{}\t{}\n",
        now_ms(),
        kind,
        detail.replace('\n', "\\n").replace('\t', " ")
    );
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    Ok(())
}

fn read_audit_json(data_home: &str) -> Result<String, Box<dyn std::error::Error>> {
    let path = PathBuf::from(data_home).join("audit").join(AUDIT_FILE_NAME);
    let raw = fs::read_to_string(path).unwrap_or_default();
    let items = raw
        .lines()
        .rev()
        .take(100)
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let at_ms = parts.next()?;
            let kind = parts.next()?;
            let detail = parts.next().unwrap_or_default();
            Some(format!(
                "{{\"atMs\":{},\"kind\":\"{}\",\"detail\":\"{}\"}}",
                at_ms.parse::<u128>().unwrap_or(0),
                escape_json(kind),
                escape_json(detail)
            ))
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("{{\"items\":[{}]}}", items))
}

fn redact_for_audit(value: &str) -> String {
    let mut text = value.to_string();
    for marker in ["OCTOCODE_TOKEN=", "OPENAI_API_KEY=", "OCTOCODE_API_TOKEN="] {
        if let Some(index) = text.find(marker) {
            let start = index + marker.len();
            let end = text[start..]
                .find(|ch: char| ch.is_whitespace() || ch == '&')
                .map(|offset| start + offset)
                .unwrap_or_else(|| text.len());
            text.replace_range(start..end, "<redacted>");
        }
    }
    if text.len() > 500 {
        text.truncate(500);
        text.push_str("...[truncated]");
    }
    text
}

fn serve_static(request: &HttpRequest) -> Result<String, Box<dyn std::error::Error>> {
    let relative = match request.path.as_str() {
        "/ui-shell" | "/ui-shell/" => String::from("ui-shell/index.html"),
        path if path.starts_with("/ui-shell/") => path.trim_start_matches('/').to_string(),
        _ => return error_response(404, "not found"),
    };

    if relative.contains("..") {
        return error_response(403, "forbidden");
    }

    let file_path = PathBuf::from(&relative);
    if !file_path.is_file() {
        return error_response(404, "not found");
    }

    let body = fs::read_to_string(&file_path)?;
    let content_type = content_type_for(&file_path);
    Ok(http_response(200, "OK", content_type, body))
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        _ => "text/plain; charset=utf-8",
    }
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, Box<dyn std::error::Error>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let mut header_end = None;

    while header_end.is_none() {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        header_end = find_header_end(&buffer);
    }

    let header_end = header_end.ok_or_else(|| OctoError::Runtime(String::from("invalid HTTP request")))?;
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| OctoError::Runtime(String::from("missing request line")))?;
    let mut request_line_parts = request_line.split_whitespace();
    let method = request_line_parts.next().unwrap_or_default().to_string();
    let target = request_line_parts.next().unwrap_or("/");
    let (path, query) = split_target(target);

    let mut content_length = 0usize;
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse::<usize>().unwrap_or(0);
            }
            headers.push((name, value));
        }
    }

    let mut body = buffer[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    Ok(HttpRequest {
        method,
        path: path.to_string(),
        query: query.to_string(),
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn split_target(target: &str) -> (&str, &str) {
    if let Some((path, query)) = target.split_once('?') {
        (path, query)
    } else {
        (target, "")
    }
}

fn http_redirect(location: &str) -> String {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        location
    )
}

fn json_response(body: String) -> Result<String, Box<dyn std::error::Error>> {
    Ok(http_response(200, "OK", "application/json; charset=utf-8", body))
}

fn error_response(status: u16, message: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok(http_response(
        status,
        if status == 404 { "Not Found" } else { "Error" },
        "application/json; charset=utf-8",
        format!("{{\"error\":\"{}\"}}", escape_json(message)),
    ))
}

fn http_response(status: u16, status_text: &str, content_type: &str, body: String) -> String {
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        content_type,
        body.len(),
        body
    )
}

fn escape_json(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug, Clone)]
struct HttpRequest {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl HttpRequest {
    fn header(&self, key: &str) -> Option<String> {
        let key = key.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(name, _)| name == &key)
            .map(|(_, value)| value.clone())
    }

    fn query_value(&self, key: &str) -> Option<String> {
        parse_pairs(&self.query)
            .into_iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    fn form_value(&self, key: &str) -> Option<String> {
        parse_pairs(&self.body)
            .into_iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    fn is_local_host_request(&self) -> bool {
        let Some(host) = self.header("host") else {
            return true;
        };
        is_local_origin_host(&host)
    }

    fn has_trusted_origin(&self) -> bool {
        let Some(origin) = self.header("origin") else {
            return true;
        };
        is_trusted_local_origin(&origin)
    }
}

fn is_local_origin_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let host = host.split(':').next().unwrap_or(host.as_str());
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

fn is_trusted_local_origin(origin: &str) -> bool {
    let origin = origin.trim().to_ascii_lowercase();
    for prefix in ["http://", "https://"] {
        if let Some(rest) = origin.strip_prefix(prefix) {
            return is_local_origin_host(rest);
        }
    }
    false
}

fn parse_pairs(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (url_decode(name), url_decode(value))
        })
        .collect()
}

fn url_decode(input: &str) -> String {
    let mut bytes_out = Vec::new();
    let bytes = input.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => bytes_out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = &input[(index + 1)..(index + 3)];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    bytes_out.push(value);
                    index += 2;
                } else {
                    bytes_out.push(bytes[index]);
                }
            }
            other => bytes_out.push(other),
        }
        index += 1;
    }
    String::from_utf8_lossy(&bytes_out).to_string()
}

#[cfg(test)]
mod tests {
    use super::{is_trusted_local_origin, url_decode, HttpRequest};

    #[test]
    fn trusts_local_origins_only() {
        assert!(is_trusted_local_origin("http://127.0.0.1:999"));
        assert!(is_trusted_local_origin("http://localhost:999"));
        assert!(!is_trusted_local_origin("https://example.com"));
    }

    #[test]
    fn decodes_utf8_form_values() {
        assert_eq!(url_decode("hello+%E4%B8%96%E7%95%8C"), "hello 世界");
    }

    #[test]
    fn request_reads_lowercase_headers() {
        let request = HttpRequest {
            method: String::from("GET"),
            path: String::from("/api/state"),
            query: String::new(),
            headers: vec![(String::from("host"), String::from("127.0.0.1:999"))],
            body: String::new(),
        };
        assert!(request.is_local_host_request());
    }
}
