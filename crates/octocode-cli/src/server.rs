use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

use octocode_api::{BuiltinProvider, ProviderRegistry};
use octocode_core::{OctoError, PermissionMode, PlatformSupport, RuntimeConfig, ToolCall};
use octocode_runtime::{
    ConfigLoader, FileSessionStore, NativePlatform, OctocodeRuntime, WorkspaceToolExecutor,
};

pub type AppRuntime = OctocodeRuntime<BuiltinProvider, FileSessionStore, WorkspaceToolExecutor>;

pub fn build_runtime(
    workspace_root: String,
    config: RuntimeConfig,
) -> Result<AppRuntime, Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(workspace_root);
    let registry = ProviderRegistry::new();
    let provider = registry.create_from_config(&config);
    let store = FileSessionStore::new(&platform.config_paths())?;
    Ok(OctocodeRuntime::new(
        provider,
        store,
        WorkspaceToolExecutor::new(platform.context().root.clone()),
        platform.context().clone(),
        registry.all().to_vec(),
    ))
}

pub fn run_server(
    port: u16,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("Octocode WebUI ready on port {port}");

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
    let loader = ConfigLoader::new(platform.config_paths());
    let config = loader.load()?;

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Ok(http_redirect("/ui-shell/")),
        ("GET", "/api/state") => {
            let session_id = request
                .query_value("session")
                .or(initial_session_id.clone());
            let runtime = build_runtime(workspace_root, config)?;
            json_response(runtime.snapshot_json(session_id.as_deref())?)
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
                    "danger-full-access" => PermissionMode::DangerFullAccess,
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
            handle_command(command, session_id, workspace_root, loader, config)
        }
        _ => serve_static(request),
    }
}

fn handle_command(
    command: String,
    session_id: Option<String>,
    workspace_root: String,
    loader: ConfigLoader,
    mut config: RuntimeConfig,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut parts = command.split_whitespace();
    let action = parts.next().unwrap_or_default();
    match action {
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
        "permission" => {
            if let Some(value) = parts.next() {
                config.permission_mode = match value {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                loader.save(&config)?;
            }
        }
        "approve" => {
            if let Some(value) = parts.next() {
                config.permission_mode = match value {
                    "read-only" => PermissionMode::ReadOnly,
                    "danger-full-access" => PermissionMode::DangerFullAccess,
                    _ => PermissionMode::WorkspaceWrite,
                };
                loader.save(&config)?;
            }
        }
        "health" => {}
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
        "session" => {}
        "reload" | "refresh" | "" => {}
        _ => {
            return error_response(400, &format!("unsupported command: {command}"));
        }
    }

    let runtime = build_runtime(workspace_root, config)?;
    json_response(runtime.snapshot_json(session_id.as_deref())?)
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
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_string();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("Content-Length") {
                content_length = value.parse::<usize>().unwrap_or(0);
            }
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

#[derive(Debug, Clone)]
struct HttpRequest {
    method: String,
    path: String,
    query: String,
    body: String,
}

impl HttpRequest {
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
    let mut output = String::new();
    let bytes = input.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'+' => output.push(' '),
            b'%' => {
                if index + 2 < bytes.len() {
                    let hex = &input[(index + 1)..(index + 3)];
                    if let Ok(value) = u8::from_str_radix(hex, 16) {
                        output.push(value as char);
                        index += 2;
                    }
                }
            }
            other => output.push(other as char),
        }
        index += 1;
    }
    output
}
