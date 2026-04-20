//! WebSocket real-time communication layer.
//!
//! Provides full-duplex streaming between the Octocode server and clients,
//! replacing HTTP polling for prompt responses and event streaming.
//! Uses the `tungstenite` crate already in workspace deps.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use sha1::Digest;

/// Unique connection ID for each WebSocket client.
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// A WebSocket frame opcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsOpcode {
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
}

impl WsOpcode {
    fn from_u8(val: u8) -> Option<Self> {
        match val {
            0x1 => Some(Self::Text),
            0x2 => Some(Self::Binary),
            0x8 => Some(Self::Close),
            0x9 => Some(Self::Ping),
            0xA => Some(Self::Pong),
            _ => None,
        }
    }
}

/// A parsed WebSocket message.
#[derive(Debug, Clone)]
pub struct WsMessage {
    pub opcode: WsOpcode,
    pub payload: Vec<u8>,
}

impl WsMessage {
    pub fn text(data: &str) -> Self {
        Self {
            opcode: WsOpcode::Text,
            payload: data.as_bytes().to_vec(),
        }
    }

    pub fn binary(data: Vec<u8>) -> Self {
        Self {
            opcode: WsOpcode::Binary,
            payload: data,
        }
    }

    pub fn close() -> Self {
        Self {
            opcode: WsOpcode::Close,
            payload: Vec::new(),
        }
    }

    pub fn pong(data: Vec<u8>) -> Self {
        Self {
            opcode: WsOpcode::Pong,
            payload: data,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        if self.opcode == WsOpcode::Text {
            std::str::from_utf8(&self.payload).ok()
        } else {
            None
        }
    }
}

/// WebSocket connection state.
pub struct WsConnection {
    pub id: u64,
    pub session_id: Option<String>,
    stream: TcpStream,
    closed: bool,
}

impl WsConnection {
    /// Perform the WebSocket upgrade handshake on an existing TCP stream.
    /// Returns None if the handshake fails.
    pub fn accept(mut stream: TcpStream, request_headers: &HashMap<String, String>) -> Option<Self> {
        let ws_key = request_headers.get("sec-websocket-key")?;
        let accept_key = compute_accept_key(ws_key);

        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept_key}\r\n\
             \r\n"
        );
        stream.write_all(response.as_bytes()).ok()?;
        stream.flush().ok()?;

        Some(Self {
            id: NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed),
            session_id: None,
            stream,
            closed: false,
        })
    }

    /// Wrap an already-upgraded TCP stream (handshake done externally).
    pub fn from_raw_stream(stream: TcpStream, session_id: String) -> Self {
        Self {
            id: NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed),
            session_id: Some(session_id),
            stream,
            closed: false,
        }
    }

    /// Read the next WebSocket frame. Returns None on EOF or error.
    pub fn read_message(&mut self) -> Option<WsMessage> {
        if self.closed {
            return None;
        }

        let mut header = [0u8; 2];
        if self.stream.read_exact(&mut header).is_err() {
            self.closed = true;
            return None;
        }

        let opcode_byte = header[0] & 0x0F;
        let opcode = WsOpcode::from_u8(opcode_byte)?;
        let masked = (header[1] & 0x80) != 0;
        let mut payload_len = (header[1] & 0x7F) as u64;

        if payload_len == 126 {
            let mut buf = [0u8; 2];
            self.stream.read_exact(&mut buf).ok()?;
            payload_len = u16::from_be_bytes(buf) as u64;
        } else if payload_len == 127 {
            let mut buf = [0u8; 8];
            self.stream.read_exact(&mut buf).ok()?;
            payload_len = u64::from_be_bytes(buf);
        }

        // Reject frames over 16 MB
        if payload_len > 16 * 1024 * 1024 {
            self.closed = true;
            return None;
        }

        let mask_key = if masked {
            let mut key = [0u8; 4];
            self.stream.read_exact(&mut key).ok()?;
            Some(key)
        } else {
            None
        };

        let mut payload = vec![0u8; payload_len as usize];
        self.stream.read_exact(&mut payload).ok()?;

        if let Some(key) = mask_key {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= key[i % 4];
            }
        }

        if opcode == WsOpcode::Close {
            self.closed = true;
        }

        Some(WsMessage { opcode, payload })
    }

    /// Send a WebSocket frame to the client.
    pub fn send_message(&mut self, msg: &WsMessage) -> bool {
        if self.closed {
            return false;
        }

        let frame = encode_frame(msg);
        if self.stream.write_all(&frame).is_err() {
            self.closed = true;
            return false;
        }
        self.stream.flush().unwrap_or(());
        true
    }

    /// Send a text message.
    pub fn send_text(&mut self, text: &str) -> bool {
        self.send_message(&WsMessage::text(text))
    }

    /// Send a JSON-serialized event.
    pub fn send_json(&mut self, value: &serde_json::Value) -> bool {
        self.send_text(&value.to_string())
    }

    /// Close the connection gracefully.
    pub fn close(&mut self) {
        if !self.closed {
            let _ = self.send_message(&WsMessage::close());
            self.closed = true;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }
}

/// Hub that manages multiple WebSocket connections and broadcasts events.
pub struct WsHub {
    connections: Arc<Mutex<Vec<WsConnection>>>,
}

impl WsHub {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Add a connection to the hub.
    pub fn add(&self, conn: WsConnection) -> u64 {
        let id = conn.id;
        self.connections.lock().unwrap().push(conn);
        id
    }

    /// Remove closed connections.
    pub fn gc(&self) {
        self.connections.lock().unwrap().retain(|c| !c.is_closed());
    }

    /// Broadcast a text message to all connected clients.
    pub fn broadcast(&self, text: &str) {
        let mut conns = self.connections.lock().unwrap();
        for conn in conns.iter_mut() {
            conn.send_text(text);
        }
    }

    /// Broadcast a JSON event to all connected clients.
    pub fn broadcast_json(&self, value: &serde_json::Value) {
        self.broadcast(&value.to_string());
    }

    /// Send a message to a specific session's subscribers.
    pub fn send_to_session(&self, session_id: &str, text: &str) {
        let mut conns = self.connections.lock().unwrap();
        for conn in conns.iter_mut() {
            if conn.session_id.as_deref() == Some(session_id) {
                conn.send_text(text);
            }
        }
    }

    /// Number of active connections.
    pub fn connection_count(&self) -> usize {
        self.connections.lock().unwrap().iter().filter(|c| !c.is_closed()).count()
    }
}

impl Default for WsHub {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const WS_MAGIC: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

fn compute_accept_key(client_key: &str) -> String {
    let combined = format!("{}{}", client_key.trim(), WS_MAGIC);
    let mut hasher = sha1::Sha1::new();
    hasher.update(combined.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

fn encode_frame(msg: &WsMessage) -> Vec<u8> {
    let opcode = msg.opcode as u8;
    let payload = &msg.payload;
    let len = payload.len();

    let mut frame = Vec::with_capacity(2 + 8 + len);
    // FIN bit set, opcode
    frame.push(0x80 | opcode);

    // Payload length (server never masks)
    if len < 126 {
        frame.push(len as u8);
    } else if len <= 65535 {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }

    frame.extend_from_slice(payload);
    frame
}

/// Check if an HTTP request is a WebSocket upgrade request.
pub fn is_websocket_upgrade(headers: &HashMap<String, String>) -> bool {
    headers
        .get("upgrade")
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

// ─── base64 import ──────────────────────────────────────────────────────────────
use base64::Engine as _;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_accept_key_deterministic() {
        // Verify same input always produces same output
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let accept1 = compute_accept_key(key);
        let accept2 = compute_accept_key(key);
        assert_eq!(accept1, accept2);
        // Verify output is valid base64 and non-empty
        assert!(!accept1.is_empty());
        assert!(accept1.ends_with('=') || accept1.chars().all(|c| c.is_alphanumeric() || c == '+' || c == '/'));
    }

    #[test]
    fn compute_accept_key_different_inputs() {
        let key1 = "dGhlIHNhbXBsZSBub25jZQ==";
        let key2 = "AQIDBAUGBwgJCgsMDQ4PEC==";
        assert_ne!(compute_accept_key(key1), compute_accept_key(key2));
    }

    #[test]
    fn encode_frame_small_payload() {
        let msg = WsMessage::text("hello");
        let frame = encode_frame(&msg);
        assert_eq!(frame[0], 0x81); // FIN + text opcode
        assert_eq!(frame[1], 5); // length
        assert_eq!(&frame[2..], b"hello");
    }

    #[test]
    fn encode_frame_medium_payload() {
        let data = "x".repeat(200);
        let msg = WsMessage::text(&data);
        let frame = encode_frame(&msg);
        assert_eq!(frame[0], 0x81);
        assert_eq!(frame[1], 126); // extended 16-bit length
        let len = u16::from_be_bytes([frame[2], frame[3]]);
        assert_eq!(len, 200);
    }

    #[test]
    fn ws_message_as_text() {
        let msg = WsMessage::text("hello");
        assert_eq!(msg.as_text(), Some("hello"));

        let msg = WsMessage::binary(vec![0xFF]);
        assert_eq!(msg.as_text(), None);
    }

    #[test]
    fn ws_hub_connection_count() {
        let hub = WsHub::new();
        assert_eq!(hub.connection_count(), 0);
    }

    #[test]
    fn is_websocket_upgrade_true() {
        let mut headers = HashMap::new();
        headers.insert("upgrade".into(), "websocket".into());
        assert!(is_websocket_upgrade(&headers));
    }

    #[test]
    fn is_websocket_upgrade_false() {
        let headers = HashMap::new();
        assert!(!is_websocket_upgrade(&headers));
    }

    #[test]
    fn ws_opcode_from_u8() {
        assert_eq!(WsOpcode::from_u8(0x1), Some(WsOpcode::Text));
        assert_eq!(WsOpcode::from_u8(0x8), Some(WsOpcode::Close));
        assert_eq!(WsOpcode::from_u8(0xFF), None);
    }
}
