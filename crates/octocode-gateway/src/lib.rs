//! Messaging gateway crate. Provides a transport-agnostic surface that
//! lets octocode-runtime push notifications and ingest commands across
//! third-party messaging platforms (Telegram first, more later).
//!
//! This crate is intentionally network-free for the MVP slice: the only
//! shipped backend is a *stub* Telegram client built around a
//! [`MessageTransport`] trait so callers can plug in `ureq` (or any
//! other HTTP client) at the boundary without dragging the dependency
//! into octocode-runtime.

use octocode_core::OctoError;

/// Minimal outbound message envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundMessage {
    pub chat_id: String,
    pub text: String,
}

/// Pluggable HTTP transport. Implementors send a POST with a body and
/// receive the raw response body. Errors must be `OctoError::Runtime`
/// so callers can bubble them through existing runtime plumbing.
pub trait MessageTransport: Send + Sync {
    fn post(&self, url: &str, form: &[(String, String)]) -> Result<String, OctoError>;
}

/// Telegram Bot API client. Wire-compatible with
/// `https://api.telegram.org/bot<TOKEN>/<METHOD>`. Requires the caller
/// to inject a `MessageTransport` so this crate stays free of HTTP
/// dependencies.
#[derive(Debug, Clone)]
pub struct TelegramGateway {
    token: String,
    base_url: String,
}

impl TelegramGateway {
    /// Create a gateway bound to a bot token. The token is read from the
    /// `OCTOCODE_TELEGRAM_TOKEN` environment variable in production
    /// (see README); here we accept it explicitly so tests can pass a
    /// fixture value.
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            base_url: String::from("https://api.telegram.org"),
        }
    }

    /// Override the API base URL. Useful for mock servers in tests.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    fn endpoint(&self, method: &str) -> String {
        format!("{}/bot{}/{}", self.base_url, self.token, method)
    }

    /// Verify the bot is reachable. Returns the bot username on success.
    pub fn get_me(&self, transport: &dyn MessageTransport) -> Result<String, OctoError> {
        let body = transport.post(&self.endpoint("getMe"), &[])?;
        // Tiny, dependency-free extraction of the `username` field.
        // Mock transports in tests return JSON we control, so we don't
        // need a full parser here.
        if let Some(name) = extract_string_field(&body, "username") {
            return Ok(name);
        }
        Err(OctoError::Runtime(format!(
            "telegram getMe response missing 'username': {body}"
        )))
    }

    /// Send a message to `chat_id`. Returns the message id reported by
    /// Telegram. The stub transport in tests returns a fixed id so the
    /// happy path is exercised without network access.
    pub fn send_message(
        &self,
        transport: &dyn MessageTransport,
        msg: &OutboundMessage,
    ) -> Result<String, OctoError> {
        if msg.chat_id.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("chat_id must be non-empty")));
        }
        if msg.text.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("text must be non-empty")));
        }
        let body = transport.post(
            &self.endpoint("sendMessage"),
            &[
                (String::from("chat_id"), msg.chat_id.clone()),
                (String::from("text"), msg.text.clone()),
            ],
        )?;
        if let Some(id) = extract_string_field(&body, "message_id") {
            return Ok(id);
        }
        Err(OctoError::Runtime(format!(
            "telegram sendMessage response missing 'message_id': {body}"
        )))
    }
}

/// Extract `"<field>":<value>` from a flat JSON response. Handles both
/// quoted-string and bare-number values. Returns `None` when the field
/// is absent. Intentionally minimal — the gateway does not own a JSON
/// parser dependency.
fn extract_string_field(body: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let idx = body.find(&needle)?;
    let rest = &body[idx + needle.len()..];
    let after_colon = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
    if let Some(stripped) = after_colon.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some(String::from(&stripped[..end]))
    } else {
        // Bare number / token until a comma, brace, or whitespace.
        let end = after_colon
            .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
            .unwrap_or(after_colon.len());
        let value = after_colon[..end].trim();
        if value.is_empty() {
            None
        } else {
            Some(String::from(value))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockTransport {
        responses: Mutex<Vec<String>>,
        seen: Mutex<Vec<(String, Vec<(String, String)>)>>,
    }

    impl MockTransport {
        fn new(responses: Vec<&str>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().map(String::from).collect()),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<(String, Vec<(String, String)>)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl MessageTransport for MockTransport {
        fn post(&self, url: &str, form: &[(String, String)]) -> Result<String, OctoError> {
            self.seen
                .lock()
                .unwrap()
                .push((url.to_string(), form.to_vec()));
            let mut q = self.responses.lock().unwrap();
            if q.is_empty() {
                return Err(OctoError::Runtime(String::from("no mock response queued")));
            }
            Ok(q.remove(0))
        }
    }

    #[test]
    fn get_me_extracts_username_from_response() {
        let transport = MockTransport::new(vec![
            r#"{"ok":true,"result":{"id":42,"username":"octocode_bot"}}"#,
        ]);
        let gw = TelegramGateway::new("STUB_TOKEN").with_base_url("http://mock.local");
        let name = gw.get_me(&transport).expect("getMe");
        assert_eq!(name, "octocode_bot");
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "http://mock.local/botSTUB_TOKEN/getMe");
    }

    #[test]
    fn send_message_posts_chat_id_and_text() {
        let transport =
            MockTransport::new(vec![r#"{"ok":true,"result":{"message_id":777}}"#]);
        let gw = TelegramGateway::new("STUB").with_base_url("http://mock.local");
        let id = gw
            .send_message(
                &transport,
                &OutboundMessage {
                    chat_id: String::from("12345"),
                    text: String::from("hello from octocode"),
                },
            )
            .expect("send");
        assert_eq!(id, "777");
        let calls = transport.calls();
        assert_eq!(calls[0].0, "http://mock.local/botSTUB/sendMessage");
        let form = &calls[0].1;
        assert!(form.iter().any(|(k, v)| k == "chat_id" && v == "12345"));
        assert!(form.iter().any(|(k, v)| k == "text" && v == "hello from octocode"));
    }

    #[test]
    fn rejects_empty_chat_id_and_text() {
        let transport = MockTransport::new(vec![]);
        let gw = TelegramGateway::new("STUB");
        let err = gw
            .send_message(
                &transport,
                &OutboundMessage { chat_id: String::new(), text: String::from("x") },
            )
            .expect_err("must reject empty chat id");
        assert!(err.to_string().contains("chat_id"));
        let err = gw
            .send_message(
                &transport,
                &OutboundMessage { chat_id: String::from("1"), text: String::new() },
            )
            .expect_err("must reject empty text");
        assert!(err.to_string().contains("text"));
    }

    #[test]
    fn surfaces_runtime_error_on_malformed_response() {
        let transport = MockTransport::new(vec![r#"{"ok":false}"#]);
        let gw = TelegramGateway::new("STUB").with_base_url("http://mock.local");
        let err = gw.get_me(&transport).expect_err("must error");
        assert!(err.to_string().contains("missing 'username'"));
    }
}
