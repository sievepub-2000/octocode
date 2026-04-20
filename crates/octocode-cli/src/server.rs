use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Instant;

use octocode_api::{BuiltinProvider, ProviderRegistry};
use octocode_commands::{
    execute_command, is_allowed_web_port, CliCommand, WEB_PORT_MAX, WEB_PORT_MIN,
};
use octocode_core::{
    OctoError, PermissionMode, PlatformSupport, ProviderFactory, RuntimeConfig, TaskKind,
    TaskState, ToolCall,
};
use octocode_runtime::{
    ConfigLoader, CoordinatorEngine, FileSessionStore, NativePlatform, OctocodeRuntime,
    RuntimeProviderRouter, TaskStore, WorkspaceToolExecutor,
};
use crate::ws;

/// Maximum HTTP request body size (10 MB).
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Maximum API requests per second per IP (simple sliding window).
const RATE_LIMIT_PER_SEC: usize = 30;

/// Simple sliding-window rate limiter keyed by client address string.
struct RateLimiter {
    windows: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `true` if the request is allowed, `false` if rate-limited.
    fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let cutoff = now - std::time::Duration::from_secs(1);
        let mut map = self.windows.lock().unwrap();
        let timestamps = map.entry(key.to_string()).or_default();
        timestamps.retain(|t| *t > cutoff);
        if timestamps.len() >= RATE_LIMIT_PER_SEC {
            return false;
        }
        timestamps.push(now);
        true
    }
}

static RATE_LIMITER: OnceLock<RateLimiter> = OnceLock::new();

fn rate_limiter() -> &'static RateLimiter {
    RATE_LIMITER.get_or_init(RateLimiter::new)
}

pub type AppRuntime = OctocodeRuntime<RuntimeProviderRouter<BuiltinProvider>, FileSessionStore, WorkspaceToolExecutor>;

static SHARED_TASK_STORE: OnceLock<TaskStore> = OnceLock::new();
static SHARED_COORDINATOR: OnceLock<CoordinatorEngine> = OnceLock::new();
static SERVER_AUTH_TOKEN: OnceLock<String> = OnceLock::new();

fn shared_task_store() -> TaskStore {
    SHARED_TASK_STORE.get_or_init(TaskStore::new).clone()
}

fn shared_coordinator() -> CoordinatorEngine {
    SHARED_COORDINATOR
        .get_or_init(CoordinatorEngine::new)
        .clone()
}

/// Generate a cryptographically random hex token for server auth.
fn generate_auth_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

fn get_server_token() -> &'static str {
    SERVER_AUTH_TOKEN.get_or_init(generate_auth_token)
}

/// Validate the auth token from request headers.
/// Returns true if auth is valid or auth is disabled (no token set).
fn check_auth(headers: &HashMap<String, String>) -> bool {
    let expected = get_server_token();
    // Allow requests from the same-origin WebUI (served by us)
    // by checking the Authorization header or x-auth-token header.
    if let Some(auth) = headers.get("authorization") {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return token.trim() == expected;
        }
    }
    if let Some(token) = headers.get("x-auth-token") {
        return token.trim() == expected;
    }
    false
}

fn summarize_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return String::from(value);
    }
    let mut out = value.chars().take(max_chars).collect::<String>();
    out.push_str(" ...");
    out
}

fn execute_async_task(runtime: &AppRuntime, session_id: &str, kind: TaskKind, label: &str) -> Result<String, OctoError> {
    match kind {
        TaskKind::Workflow => {
            let result = runtime.run_tool_in_session(
                session_id,
                ToolCall {
                    name: String::from("workflow-plan"),
                    input: String::from(label),
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            Ok(format!("workflow completed: {}", summarize_text(&result.output, 220)))
        }
        TaskKind::Agent => {
            let result = runtime.agent_action_in_session(session_id, label)?;
            Ok(format!("agent completed: {}", summarize_text(&result.output, 220)))
        }
        TaskKind::Tool => {
            let (tool_name, tool_input) = if let Some((name, input)) = label.split_once('|') {
                let parsed_name = name.trim();
                if parsed_name.is_empty() {
                    (String::from("echo"), String::from(input.trim()))
                } else {
                    (String::from(parsed_name), String::from(input.trim()))
                }
            } else {
                (String::from("echo"), String::from(label))
            };

            if tool_name.starts_with("task-") || tool_name.starts_with("team-") {
                return Err(OctoError::Runtime(format!(
                    "tool task does not support recursive orchestration tool '{}'",
                    tool_name
                )));
            }

            let result = runtime.run_tool_in_session(
                session_id,
                ToolCall {
                    name: tool_name.clone(),
                    input: tool_input,
                    permission: PermissionMode::ReadOnly,
                },
            )?;
            Ok(format!(
                "tool {} completed: {}",
                tool_name,
                summarize_text(&result.output, 220)
            ))
        }
    }
}

fn start_async_task_worker(
    workspace_root: String,
    task_id: String,
    session_id: String,
    kind: TaskKind,
    label: String,
) {
    thread::spawn(move || {
        let run = || -> Result<(), Box<dyn std::error::Error>> {
            let platform = NativePlatform::detect(workspace_root.clone());
            let loader = ConfigLoader::new(platform.config_paths());
            let config = loader.load()?;
            let runtime = build_runtime(workspace_root.clone(), config)?;

            let _ = runtime.task_start(&task_id, Some(String::from("worker started")));
            match execute_async_task(&runtime, &session_id, kind.clone(), &label) {
                Ok(summary) => {
                    let _ = runtime.task_finish(&task_id, TaskState::Done, Some(summary));
                }
                Err(error) => {
                    let _ = runtime.task_finish(
                        &task_id,
                        TaskState::Failed,
                        Some(error.to_string()),
                    );
                }
            }
            Ok(())
        };

        if let Err(error) = run() {
            eprintln!("async task worker failed (task={}): {}", task_id, error);
        }
    });
}

pub fn build_runtime(
    workspace_root: String,
    config: RuntimeConfig,
) -> Result<AppRuntime, Box<dyn std::error::Error>> {
    let platform = NativePlatform::detect(workspace_root);
    let registry = ProviderRegistry::new();
    let store = FileSessionStore::new(&platform.config_paths())?;
    let mut runtime = OctocodeRuntime::new(
        RuntimeProviderRouter::from_factory(&registry, &config)?,
        store,
        WorkspaceToolExecutor::with_shell(
            platform.context().root.clone(),
            platform.context().preferred_shell.clone(),
        ),
        platform.context().clone(),
        registry.descriptors().to_vec(),
    );
    runtime.task_store = shared_task_store();
    runtime.coordinator = shared_coordinator();
    Ok(runtime)
}

/// Fixed-size thread pool for handling concurrent HTTP connections.
struct ThreadPool {
    workers: Vec<thread::JoinHandle<()>>,
    sender: Option<mpsc::Sender<Box<dyn FnOnce() + Send + 'static>>>,
}

impl ThreadPool {
    fn new(size: usize) -> Self {
        let (sender, receiver) = mpsc::channel::<Box<dyn FnOnce() + Send + 'static>>();
        let receiver = Arc::new(std::sync::Mutex::new(receiver));
        let mut workers = Vec::with_capacity(size);

        for _ in 0..size {
            let receiver = Arc::clone(&receiver);
            let handle = thread::spawn(move || loop {
                let job = {
                    let lock = receiver.lock().expect("thread pool mutex poisoned");
                    lock.recv()
                };
                match job {
                    Ok(job) => job(),
                    Err(_) => break, // channel closed, shut down
                }
            });
            workers.push(handle);
        }

        ThreadPool {
            workers,
            sender: Some(sender),
        }
    }

    fn execute<F: FnOnce() + Send + 'static>(&self, f: F) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(Box::new(f));
        }
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        // Drop the sender to signal workers to stop
        drop(self.sender.take());
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

/// Number of worker threads for the HTTP server.
const THREAD_POOL_SIZE: usize = 8;

pub fn run_server(
    port: u16,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !is_allowed_web_port(port) {
        return Err(format!(
            "port {} is out of allowed range {}-{}",
            port, WEB_PORT_MIN, WEB_PORT_MAX
        )
        .into());
    }

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;

    // Generate and display auth token for API access
    let token = get_server_token();
    println!("Octocode WebUI ready on port {port} (thread pool: {THREAD_POOL_SIZE} workers)");
    println!("Auth token: {token}");

    // Write token to a file for the WebUI to read
    let token_path = std::env::temp_dir().join(format!("octocode-auth-{port}.token"));
    let _ = fs::write(&token_path, token);

    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let flag = Arc::clone(&shutdown);
        ctrlc::set_handler(move || {
            eprintln!("\nreceived Ctrl+C, shutting down...");
            flag.store(true, Ordering::SeqCst);
        })?;
    }

    let pool = ThreadPool::new(THREAD_POOL_SIZE);
    let session_id = Arc::new(initial_session_id);

    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let session_id = Arc::clone(&session_id);
                pool.execute(move || {
                    let sid = (*session_id).clone();
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_connection(stream, sid)
                    }));
                    match result {
                        Ok(Err(error)) => {
                            let msg = error.to_string();
                            // Suppress noise from empty/scanner connections and localized
                            // socket reset/abort errors when the peer closes early.
                            if !should_suppress_request_error(error.as_ref()) {
                                eprintln!("server error: {msg}");
                            }
                        }
                        Err(_) => eprintln!("server panic: request handler panicked — worker recovered"),
                        Ok(Ok(())) => {}
                    }
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => eprintln!("accept error: {error}"),
        }
    }

    println!("Octocode server shutting down gracefully...");
    drop(pool);
    println!("Octocode server stopped.");
    Ok(())
}

fn handle_connection(
    mut stream: TcpStream,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Accepted sockets may inherit non-blocking mode from the listener on
    // some platforms; force blocking so reads wait for data.
    stream.set_nonblocking(false)?;
    // Timeout so stale / scanner connections don't block a worker forever.
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;

    let request = match read_http_request(&mut stream) {
        Ok(req) => req,
        Err(err) => {
            // Empty / malformed connections (port scanners, pre-connect) are
            // expected — silently drop them instead of printing a scary error.
            return Err(err);
        }
    };

    // CORS preflight
    if request.method == "OPTIONS" {
        let preflight = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization, X-Auth-Token\r\nAccess-Control-Max-Age: 86400\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(preflight.as_bytes())?;
        stream.flush()?;
        return Ok(());
    }

    // Auth check for API endpoints (exempt: health, static assets, token endpoint)
    let requires_auth = request.path.starts_with("/api/")
        && request.path != "/api/health"
        && request.path != "/api/auth-token";
    if requires_auth && !check_auth(&request.headers) {
        let body = r#"{"error":"unauthorized","message":"missing or invalid auth token"}"#;
        let response = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes())?;
        stream.flush()?;
        return Ok(());
    }

    // Rate limiting for API endpoints
    if request.path.starts_with("/api/") {
        let client_key = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
        if !rate_limiter().check(&client_key) {
            let body = r#"{"error":"rate_limited","message":"too many requests"}"#;
            let response = format!(
                "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes())?;
            stream.flush()?;
            return Ok(());
        }
    }

    // SSE streaming endpoint — needs direct stream access
    if request.method == "GET" && request.path == "/api/stream" {
        return handle_sse_stream(&mut stream, &request, initial_session_id);
    }

    // WebSocket upgrade
    if request.method == "GET"
        && request.path == "/ws"
        && request
            .headers
            .get("upgrade")
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    {
        return handle_ws_upgrade(&mut stream, &request, initial_session_id);
    }

    let response = match route_request(&request, initial_session_id) {
        Ok(r) => r,
        Err(err) => {
            let msg = format!("{err}");
            error_response(500, &msg)?
        }
    };
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn handle_sse_stream(
    stream: &mut TcpStream,
    request: &HttpRequest,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = request
        .query_value("session")
        .or(initial_session_id)
        .unwrap_or_else(|| String::from("demo"));
    let text = request.query_value("text").unwrap_or_default();

    if text.is_empty() {
        let err = error_response(400, "missing text parameter")?;
        stream.write_all(err.as_bytes())?;
        stream.flush()?;
        return Ok(());
    }

    // Write SSE headers
    let headers = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream\r\n",
        "Cache-Control: no-cache\r\n",
        "Connection: keep-alive\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "\r\n"
    );
    stream.write_all(headers.as_bytes())?;
    stream.flush()?;

    let workspace_root = String::from(".");
    let platform = NativePlatform::detect(workspace_root.clone());
    let loader = ConfigLoader::new(platform.config_paths());
    let config = loader.load()?;
    let runtime = build_runtime(workspace_root, config)?;

    // Stream tokens via SSE
    let stream_ref = std::cell::RefCell::new(stream);
    let mut token_count: usize = 0;
    let stream_result = runtime.prompt_stream_in_session(
        &session_id,
        &text,
        &mut |token: &str| {
            token_count += 1;
            let escaped = escape_json(token);
            let event = format!(
                "data: {{\"token\":\"{}\",\"index\":{}}}\n\n",
                escaped, token_count
            );
            let mut s = stream_ref.borrow_mut();
            let _ = s.write_all(event.as_bytes());
            let _ = s.flush();
        },
    );

    // Send done event
    let mut s = stream_ref.borrow_mut();
    match stream_result {
        Ok(_) => {
            s.write_all(b"data: [DONE]\n\n")?;
        }
        Err(error) => {
            let err_event = format!(
                "data: {{\"error\":\"{}\"}}\n\n",
                escape_json(&error.to_string())
            );
            s.write_all(err_event.as_bytes())?;
        }
    }
    s.flush()?;
    Ok(())
}

// ── WebSocket support ─────────────────────────────────────────────────────────

/// RFC 6455 §4.2.2 WebSocket magic GUID.
const WS_MAGIC: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Shared WebSocket hub for tracking active connections and broadcasting events.
static WS_HUB: OnceLock<ws::WsHub> = OnceLock::new();

fn ws_hub() -> &'static ws::WsHub {
    WS_HUB.get_or_init(ws::WsHub::new)
}

fn handle_ws_upgrade(
    stream: &mut TcpStream,
    request: &HttpRequest,
    initial_session_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws_key = request
        .headers
        .get("sec-websocket-key")
        .ok_or_else(|| OctoError::Runtime(String::from("missing Sec-WebSocket-Key")))?;

    // Compute accept key: SHA-1(key + magic), then Base64
    use sha1::Digest;
    let mut hasher = sha1::Sha1::new();
    hasher.update(ws_key.as_bytes());
    hasher.update(WS_MAGIC.as_bytes());
    let accept = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hasher.finalize());

    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
    );
    stream.write_all(handshake.as_bytes())?;
    stream.flush()?;

    // Session
    let session_id = request
        .query_value("session")
        .or(initial_session_id)
        .unwrap_or_else(|| String::from("demo"));

    // Register this connection in the shared hub for broadcasting.
    let hub = ws_hub();
    let conn = ws::WsConnection::from_raw_stream(stream.try_clone()?, session_id.clone());
    let conn_id = hub.add(conn);

    // Simple WebSocket message loop
    loop {
        let msg = match ws_read_frame(stream) {
            Ok(Some(msg)) => msg,
            Ok(None) => break, // close frame or connection ended
            Err(_) => break,
        };

        // Treat each message as a chat prompt; stream tokens back as WS text frames.
        let workspace_root = String::from(".");
        let platform = NativePlatform::detect(workspace_root.clone());
        let loader = ConfigLoader::new(platform.config_paths());
        let config = loader.load()?;
        let runtime = build_runtime(workspace_root, config)?;

        let stream_ref = std::cell::RefCell::new(&mut *stream);
        let mut token_count: usize = 0;
        let stream_result = runtime.prompt_stream_in_session(
            &session_id,
            &msg,
            &mut |token: &str| {
                token_count += 1;
                let escaped = escape_json(token);
                let payload = format!(
                    "{{\"token\":\"{}\",\"index\":{}}}",
                    escaped, token_count
                );
                let mut s = stream_ref.borrow_mut();
                let _ = ws_write_frame(*s, &payload);
                // Broadcast to other connections in the same session
                hub.send_to_session(&session_id, &payload);
            },
        );

        // Send done marker
        match stream_result {
            Ok(_) => {
                let _ = ws_write_frame(stream, "{\"done\":true}");
            }
            Err(error) => {
                let err_payload = format!(
                    "{{\"error\":\"{}\"}}",
                    escape_json(&error.to_string())
                );
                let _ = ws_write_frame(stream, &err_payload);
            }
        }
    }

    // Clean up closed connections from the hub
    let _ = conn_id; // used for tracking; gc removes closed conns
    hub.gc();

    Ok(())
}

/// Read a single WebSocket frame (text or binary).  Returns `None` for
/// close/ping/pong control frames.
fn ws_read_frame(stream: &mut TcpStream) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;

    let opcode = header[0] & 0x0F;
    let masked = (header[1] & 0x80) != 0;
    let mut payload_len = (header[1] & 0x7F) as u64;

    if payload_len == 126 {
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf)?;
        payload_len = u16::from_be_bytes(buf) as u64;
    } else if payload_len == 127 {
        let mut buf = [0u8; 8];
        stream.read_exact(&mut buf)?;
        payload_len = u64::from_be_bytes(buf);
    }

    // Limit frame size (same as HTTP body limit)
    if payload_len > MAX_BODY_BYTES as u64 {
        return Err(Box::new(OctoError::Runtime(String::from("WebSocket frame too large"))));
    }

    let mask_key = if masked {
        let mut key = [0u8; 4];
        stream.read_exact(&mut key)?;
        Some(key)
    } else {
        None
    };

    let mut payload = vec![0u8; payload_len as usize];
    stream.read_exact(&mut payload)?;

    if let Some(mask) = mask_key {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }

    match opcode {
        0x01 | 0x02 => Ok(Some(String::from_utf8_lossy(&payload).into_owned())),
        0x08 => Ok(None),        // close
        0x09 => {
            // ping → pong
            let _ = ws_write_control(stream, 0x0A, &payload);
            Ok(Some(String::new()))  // empty string = skip processing
        }
        _ => Ok(None),
    }
}

/// Write a text frame to a WebSocket connection (unmasked, server → client).
fn ws_write_frame(stream: &mut TcpStream, text: &str) -> Result<(), Box<dyn std::error::Error>> {
    let payload = text.as_bytes();
    let mut frame = Vec::with_capacity(payload.len() + 10);

    // FIN + text opcode
    frame.push(0x81);

    let len = payload.len();
    if len < 126 {
        frame.push(len as u8);
    } else if len < 65536 {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }

    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
    stream.flush()?;
    Ok(())
}

/// Write a WebSocket control frame (pong, close).
fn ws_write_control(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let mut frame = Vec::with_capacity(payload.len() + 2);
    frame.push(0x80 | opcode);
    frame.push(payload.len() as u8);
    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
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
            let raw = runtime.event_feed_json(session_id.as_deref())?;
            // Add relativeMs to each event: inject into the items array
            // We return the raw event feed; client computes relative timing from atMs
            json_response(raw)
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
            json_response(format!(
                "{{\"items\":[{}],\"wsConnections\":{}}}",
                body,
                ws_hub().connection_count()
            ))
        }
        ("GET", "/api/ws-status") => {
            json_response(format!(
                "{{\"connections\":{}}}",
                ws_hub().connection_count()
            ))
        }
        ("GET", "/api/tools") => {
            let runtime = build_runtime(workspace_root, config)?;
            let items: Vec<String> = runtime
                .tools()
                .iter()
                .map(|t| {
                    format!(
                        "{{\"name\":\"{}\",\"summary\":\"{}\",\"minimumPermission\":\"{:?}\"}}",
                        escape_json(t.name),
                        escape_json(t.summary),
                        t.minimum_permission
                    )
                })
                .collect();
            json_response(format!("[{}]", items.join(",")))
        }
        ("GET", "/api/tasks") => {
            let session_filter = request.query_value("session");
            let runtime = build_runtime(workspace_root, config)?;
            let tasks = runtime.task_list(session_filter.as_deref());
            let items: Vec<String> = tasks
                .iter()
                .map(|t| {
                    format!(
                        concat!(
                            "{{",
                            "\"id\":\"{}\",",
                            "\"kind\":\"{}\",",
                            "\"sessionId\":\"{}\",",
                            "\"label\":\"{}\",",
                            "\"state\":\"{}\",",
                            "\"createdAtMs\":{},",
                            "\"finishedAtMs\":{},",
                            "\"resultSummary\":{}",
                            "}}"
                        ),
                        escape_json(&t.id),
                        escape_json(&format!("{:?}", t.kind).to_lowercase()),
                        escape_json(&t.session_id),
                        escape_json(&t.label),
                        escape_json(&format!("{:?}", t.state).to_lowercase()),
                        t.created_at_ms,
                        t.finished_at_ms
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| String::from("null")),
                        t.result_summary
                            .as_deref()
                            .map(|s| format!("\"{}\"", escape_json(s)))
                            .unwrap_or_else(|| String::from("null")),
                    )
                })
                .collect();
            json_response(format!("{{\"items\":[{}]}}", items.join(",")))
        }
        ("POST", "/api/tasks") => {
            let session_id = request
                .form_value("sessionId")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| String::from("demo"));
            let label = request
                .form_value("label")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| String::from("task"));
            let kind_str = request.form_value("kind").unwrap_or_default();
            let kind = match kind_str.trim() {
                "workflow" => TaskKind::Workflow,
                "tool" => TaskKind::Tool,
                _ => TaskKind::Agent,
            };
            let runtime = build_runtime(workspace_root, config)?;
            let rec = runtime.task_submit(kind, &session_id, &label);
            start_async_task_worker(
                String::from("."),
                rec.id.clone(),
                rec.session_id.clone(),
                rec.kind.clone(),
                rec.label.clone(),
            );
            json_response(format!(
                concat!(
                    "{{",
                    "\"id\":\"{}\",",
                    "\"sessionId\":\"{}\",",
                    "\"label\":\"{}\",",
                    "\"state\":\"pending\"",
                    "}}"
                ),
                escape_json(&rec.id),
                escape_json(&rec.session_id),
                escape_json(&rec.label),
            ))
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
            if let Some(deny_tool) = request.form_value("denyTool") {
                let dn = deny_tool.trim().to_string();
                if !dn.is_empty() && !next.denied_tools.contains(&dn) {
                    next.denied_tools.push(dn);
                }
            }
            if let Some(allow_tool) = request.form_value("allowTool") {
                let an = allow_tool.trim().to_string();
                next.denied_tools.retain(|t| *t != an);
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
        // Read-only observability commands — fall through to snapshot at end
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
        // ── iteration-1: git + context + tokens + tree slash-commands ──────
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
            // Return token count summary for the active session
            let eff_session = session_id.clone().unwrap_or_else(|| String::from("demo"));
            let runtime = build_runtime(workspace_root, config)?;
            let snapshot = runtime.snapshot_json(Some(&eff_session))?;
            // Rough char-based token estimate from messages in snapshot JSON
            // Count chars between "content":"..." fields
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
        "mcp" => {
            let subcommand = parts.next().unwrap_or("list");
            let workspace_root_path = workspace_root.clone();
            let platform = NativePlatform::detect(workspace_root_path);
            let config_paths = platform.config_paths();
            match octocode_mcp::McpRegistry::discover(&platform.context().root, &config_paths.config_home) {
                Ok(registry) => {
                    let items: Vec<String> = registry.servers().iter().map(|s| {
                        format!(
                            "{{\"id\":\"{}\",\"transport\":\"{}\",\"state\":\"{}\",\"detail\":\"{}\",\"trusted\":{}}}",
                            escape_json(&s.descriptor.id),
                            escape_json(s.descriptor.transport.as_str()),
                            escape_json(s.state.as_str()),
                            escape_json(&s.detail),
                            s.descriptor.trusted,
                        )
                    }).collect();
                    let body = format!("{{\"command\":\"mcp {}\",\"items\":[{}]}}", subcommand, items.join(","));
                    return json_response(body);
                }
                Err(err) => {
                    return json_response(format!("{{\"command\":\"mcp {}\",\"items\":[],\"error\":\"{}\"}}", subcommand, escape_json(&err)));
                }
            }
        }
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

    let file_path = if let Some(path) = resolve_static_path(&relative) {
        path
    } else {
        return error_response(404, "not found");
    };

    let body = fs::read_to_string(&file_path)
        .map_err(|e| OctoError::Runtime(format!("failed to read {}: {e}", file_path.display())))?;
    let content_type = content_type_for(&file_path);
    Ok(http_response(200, "OK", content_type, body))
}

fn resolve_static_path(relative: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(relative);
    if direct.is_file() {
        return Some(direct);
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent().unwrap_or(Path::new("."));

    // Search next to the binary first, then walk up parent directories so a
    // target/release binary can still find the workspace ui-shell/ assets.
    for base in exe_dir.ancestors().take(6) {
        let candidate = base.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
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
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name_trimmed = name.trim().to_string();
            let value_trimmed = value.trim().to_string();
            if name_trimmed.eq_ignore_ascii_case("Content-Length") {
                content_length = value_trimmed.parse::<usize>().unwrap_or(0);
            }
            headers.insert(name_trimmed.to_ascii_lowercase(), value_trimmed);
        }
    }

    // Guard against oversized request bodies.
    if content_length > MAX_BODY_BYTES {
        return Err(Box::new(OctoError::Runtime(format!(
            "request body too large ({content_length} bytes, limit {MAX_BODY_BYTES})"
        ))));
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
        headers,
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
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\r' => result.push_str("\\r"),
            '\n' => result.push_str("\\n"),
            '\t' => result.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                result.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => result.push(c),
        }
    }
    result
}

fn should_suppress_request_error(error: &(dyn std::error::Error + 'static)) -> bool {
    if error_chain_contains_io_kind(
        error,
        &[
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::ConnectionAborted,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::UnexpectedEof,
        ],
    ) {
        return true;
    }

    let message = error.to_string().to_ascii_lowercase();
    message.contains("invalid http request")
        || message.contains("missing request line")
        || message.contains("timed out")
        || message.contains("connection reset")
        || message.contains("connection abort")
}

fn error_chain_contains_io_kind(
    error: &(dyn std::error::Error + 'static),
    expected: &[std::io::ErrorKind],
) -> bool {
    let mut current = Some(error);
    while let Some(err) = current {
        if let Some(io_error) = err.downcast_ref::<std::io::Error>() {
            if expected.iter().any(|kind| io_error.kind() == *kind) {
                return true;
            }
        }
        current = err.source();
    }
    false
}

#[derive(Debug, Clone)]
struct HttpRequest {
    method: String,
    path: String,
    query: String,
    body: String,
    headers: HashMap<String, String>,
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
    let bytes = input.as_bytes();
    let mut raw: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'+' => raw.push(b' '),
            b'%' => {
                if index + 2 < bytes.len() {
                    let hex = &input[(index + 1)..(index + 3)];
                    if let Ok(value) = u8::from_str_radix(hex, 16) {
                        raw.push(value);
                        index += 2;
                    } else {
                        raw.push(byte);
                    }
                } else {
                    raw.push(byte);
                }
            }
            other => raw.push(other),
        }
        index += 1;
    }
    String::from_utf8(raw).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        error_chain_contains_io_kind, escape_json, parse_pairs, should_suppress_request_error,
        url_decode,
    };
    use std::io::ErrorKind;

    #[test]
    fn url_decode_ascii() {
        assert_eq!(url_decode("hello+world"), "hello world");
        assert_eq!(url_decode("a%20b"), "a b");
    }

    #[test]
    fn url_decode_multibyte_utf8() {
        // 中 = E4 B8 AD
        assert_eq!(url_decode("%E4%B8%AD"), "中");
        // 日本語 = E6 97 A5 E6 9C AC E8 AA 9E
        assert_eq!(url_decode("%E6%97%A5%E6%9C%AC%E8%AA%9E"), "日本語");
    }

    #[test]
    fn url_decode_mixed() {
        assert_eq!(url_decode("hello+%E4%B8%96%E7%95%8C"), "hello 世界");
    }

    #[test]
    fn escape_json_control_chars() {
        let input = "hello\x00world\x1f";
        let escaped = escape_json(input);
        assert_eq!(escaped, "hello\\u0000world\\u001f");
    }

    #[test]
    fn escape_json_standard_escapes() {
        assert_eq!(escape_json("a\"b\\c\r\n\t"), "a\\\"b\\\\c\\r\\n\\t");
    }

    #[test]
    fn parse_pairs_with_utf8() {
        let pairs = parse_pairs("key=%E4%B8%AD&name=test");
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], (String::from("key"), String::from("中")));
        assert_eq!(pairs[1], (String::from("name"), String::from("test")));
    }

    #[test]
    fn suppresses_localized_connection_reset_errors_by_kind() {
        let error = std::io::Error::new(
            ErrorKind::ConnectionReset,
            "远程主机强迫关闭了一个现有的连接。",
        );
        assert!(should_suppress_request_error(&error));
        assert!(error_chain_contains_io_kind(&error, &[ErrorKind::ConnectionReset]));
    }

    #[test]
    fn does_not_suppress_unexpected_runtime_errors() {
        let error = std::io::Error::other("disk full");
        assert!(!should_suppress_request_error(&error));
    }

    #[test]
    fn ws_magic_matches_rfc6455() {
        assert_eq!(super::WS_MAGIC, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    }

    #[test]
    fn ws_hub_tracks_connections() {
        let hub = crate::ws::WsHub::new();
        assert_eq!(hub.connection_count(), 0);
        // hub.gc() should not panic on empty
        hub.gc();
        assert_eq!(hub.connection_count(), 0);
    }

    #[test]
    fn ws_accept_key_rfc6455_example() {
        use sha1::Digest;
        // RFC 6455 §4.2.2 example
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let combined = format!("{}{}", key.trim(), "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");

        let mut hasher = sha1::Sha1::new();
        hasher.update(combined.as_bytes());
        let accept = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            hasher.finalize(),
        );
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
}
