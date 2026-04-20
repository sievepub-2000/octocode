#![cfg(feature = "e2e")]

/// End-to-end regression tests for the Octocode HTTP server.
///
/// These tests launch the `octocode` binary with `serve --port <N>`,
/// send real HTTP requests, and validate the JSON responses.
///
/// Run with: `cargo test -p octocode-cli --features e2e -- --test-threads=1`

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Find a free port by binding to port 0.
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind to free port");
    listener.local_addr().expect("local addr").port()
}

/// Send a raw HTTP GET request and return the response body.
fn http_get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).expect("write");
    stream.flush().expect("flush");
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    if let Some(pos) = text.find("\r\n\r\n") {
        text[(pos + 4)..].to_string()
    } else {
        text
    }
}

fn http_post(port: u16, path: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).expect("write");
    stream.flush().expect("flush");
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    if let Some(pos) = text.find("\r\n\r\n") {
        text[(pos + 4)..].to_string()
    } else {
        text
    }
}

/// Spawn the server binary in the background and return (port, child).
fn spawn_server() -> (u16, std::process::Child) {
    let port = free_port();
    // Locate the binary from the target directory.
    let bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target")
        .join(if cfg!(debug_assertions) { "debug" } else { "release" })
        .join(if cfg!(target_os = "windows") { "octocode.exe" } else { "octocode" });
    let child = Command::new(&bin)
        .args(["serve", "--port", &port.to_string(), "--session", "e2e"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn {:?}: {e}", bin));
    // Give the server a moment to bind.
    std::thread::sleep(Duration::from_millis(500));
    (port, child)
}

#[test]
#[test]
fn e2e_health_endpoint() {
    let (port, mut child) = spawn_server();
    let body = http_get(port, "/api/health");
    child.kill().ok();
    assert!(body.contains("\"items\""), "health response should contain items array: {body}");
}

#[test]
fn e2e_state_endpoint() {
    let (port, mut child) = spawn_server();
    let body = http_get(port, "/api/state?session=e2e");
    child.kill().ok();
    assert!(body.starts_with('{'), "state response should be JSON: {body}");
}

#[test]
fn e2e_tools_endpoint() {
    let (port, mut child) = spawn_server();
    let body = http_get(port, "/api/tools");
    child.kill().ok();
    assert!(body.starts_with('['), "tools response should be JSON array: {body}");
    assert!(body.contains("\"name\""), "tools should list tool names: {body}");
}

#[test]
fn e2e_settings_roundtrip() {
    let (port, mut child) = spawn_server();
    let body = http_post(port, "/api/settings", "defaultModel=test-model&sessionId=e2e");
    child.kill().ok();
    assert!(body.starts_with('{'), "settings response should be JSON: {body}");
}

#[test]
fn e2e_cors_preflight() {
    let (port, mut child) = spawn_server();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let req = "OPTIONS /api/chat HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    stream.write_all(req.as_bytes()).expect("write");
    stream.flush().expect("flush");
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    child.kill().ok();
    let text = String::from_utf8_lossy(&buf).into_owned();
    assert!(
        text.contains("204 No Content") || text.contains("Access-Control-Allow-Origin"),
        "CORS preflight should return 204: {text}"
    );
}

#[test]
fn e2e_404_for_unknown_path() {
    let (port, mut child) = spawn_server();
    let body = http_get(port, "/nonexistent");
    child.kill().ok();
    assert!(body.contains("\"error\""), "unknown path should return error JSON: {body}");
}

#[test]
fn e2e_websocket_upgrade() {
    let (port, mut child) = spawn_server();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let req = format!(
        "GET /ws HTTP/1.1\r\n\
         Host: localhost:{port}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).expect("write");
    stream.flush().expect("flush");
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    child.kill().ok();
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(
        text.contains("101 Switching Protocols") || text.contains("Sec-WebSocket-Accept"),
        "WebSocket upgrade should return 101: {text}"
    );
}
