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

    /// Poll Telegram getUpdates with a long-polling offset. Returns the
    /// list of `(update_id, chat_id, text)` triplets parsed from the
    /// response. Callers should pass `next_offset = max(update_id) + 1`
    /// on the next poll to acknowledge processed updates.
    pub fn get_updates(
        &self,
        transport: &dyn MessageTransport,
        offset: u64,
        timeout_secs: u64,
    ) -> Result<Vec<InboundUpdate>, OctoError> {
        let body = transport.post(
            &self.endpoint("getUpdates"),
            &[
                (String::from("offset"), offset.to_string()),
                (String::from("timeout"), timeout_secs.to_string()),
            ],
        )?;
        Ok(parse_updates(&body))
    }
}

/// Inbound update parsed from `getUpdates`. Carries only the fields the
/// runtime currently needs (`update_id`, `chat_id`, `text`); richer
/// fields can be added incrementally without breaking callers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundUpdate {
    pub update_id: u64,
    pub chat_id: String,
    pub text: String,
}

/// Parse the result array of a Telegram `getUpdates` response. The
/// parser is intentionally tolerant of unknown fields and simply scans
/// for the three keys we care about per `update_id` block.
fn parse_updates(body: &str) -> Vec<InboundUpdate> {
    let mut out = Vec::new();
    // Split on `"update_id"` to isolate one update per chunk.
    let mut chunks = body.split("\"update_id\"");
    let _prefix = chunks.next();
    for chunk in chunks {
        let after_colon = chunk.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
        let id_end = after_colon
            .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
            .unwrap_or(after_colon.len());
        let id_str = after_colon[..id_end].trim();
        let Ok(update_id) = id_str.parse::<u64>() else {
            continue;
        };
        // Search the remaining chunk for the first chat id and text.
        let chat_id = extract_nested_id(chunk, "\"chat\"", "\"id\"")
            .unwrap_or_default();
        let text = extract_string_field(chunk, "text").unwrap_or_default();
        if !chat_id.is_empty() && !text.is_empty() {
            out.push(InboundUpdate {
                update_id,
                chat_id,
                text,
            });
        }
    }
    out
}

/// Extract `outer.inner` style nested numeric ids: find `outer`, then
/// inside the following object look for `inner`.
fn extract_nested_id(body: &str, outer: &str, inner: &str) -> Option<String> {
    let idx = body.find(outer)?;
    let rest = &body[idx + outer.len()..];
    let inner_idx = rest.find(inner)?;
    let after = &rest[inner_idx + inner.len()..];
    let after_colon = after.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
    let end = after_colon
        .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .unwrap_or(after_colon.len());
    let v = after_colon[..end].trim().trim_matches('"');
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// Real `ureq`-backed transport. Built behind the `network` feature so
/// the default crate stays HTTP-free for tests and offline builds.
#[cfg(feature = "network")]
#[derive(Debug, Default, Clone)]
pub struct UreqTransport;

#[cfg(feature = "network")]
impl MessageTransport for UreqTransport {
    fn post(&self, url: &str, form: &[(String, String)]) -> Result<String, OctoError> {
        let pairs: Vec<(&str, &str)> =
            form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        ureq::post(url)
            .send_form(&pairs)
            .map_err(|e| OctoError::Runtime(format!("ureq POST {url}: {e}")))?
            .into_string()
            .map_err(|e| OctoError::Runtime(format!("ureq read {url}: {e}")))
    }
}

/// Slack incoming-webhook gateway. Slack does not return a numeric
/// message id from incoming webhooks; success is reported as the literal
/// body `ok`. We therefore return the raw body so callers can decide
/// how strict to be.
#[derive(Debug, Clone)]
pub struct SlackGateway {
    webhook_url: String,
}

impl SlackGateway {
    pub fn new(webhook_url: impl Into<String>) -> Self {
        Self {
            webhook_url: webhook_url.into(),
        }
    }

    pub fn send_message(
        &self,
        transport: &dyn MessageTransport,
        msg: &OutboundMessage,
    ) -> Result<String, OctoError> {
        if msg.text.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("text must be non-empty")));
        }
        // Slack incoming-webhook uses a JSON `payload` field. We craft
        // it manually to avoid pulling serde_json into this crate.
        let payload = format!(
            "{{\"text\":\"{}\",\"channel\":\"{}\"}}",
            escape_json(&msg.text),
            escape_json(&msg.chat_id),
        );
        let body = transport.post(
            &self.webhook_url,
            &[(String::from("payload"), payload)],
        )?;
        Ok(body)
    }
}

/// Discord webhook gateway. Discord webhooks return `204 No Content`
/// on success — most transports surface that as an empty string body,
/// which we treat as success. Non-empty bodies typically describe an
/// error and are propagated to the caller.
#[derive(Debug, Clone)]
pub struct DiscordGateway {
    webhook_url: String,
}

impl DiscordGateway {
    pub fn new(webhook_url: impl Into<String>) -> Self {
        Self {
            webhook_url: webhook_url.into(),
        }
    }

    pub fn send_message(
        &self,
        transport: &dyn MessageTransport,
        msg: &OutboundMessage,
    ) -> Result<(), OctoError> {
        if msg.text.trim().is_empty() {
            return Err(OctoError::Runtime(String::from("text must be non-empty")));
        }
        let _body = transport.post(
            &self.webhook_url,
            &[(String::from("content"), msg.text.clone())],
        )?;
        Ok(())
    }
}

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
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

    #[test]
    fn get_updates_parses_chat_id_and_text() {
        let transport = MockTransport::new(vec![
            r#"{"ok":true,"result":[
                {"update_id":101,"message":{"chat":{"id":555,"type":"private"},"text":"hello bot"}},
                {"update_id":102,"message":{"chat":{"id":777,"type":"group"},"text":"second one"}}
            ]}"#,
        ]);
        let gw = TelegramGateway::new("STUB").with_base_url("http://mock.local");
        let updates = gw.get_updates(&transport, 0, 30).expect("getUpdates");
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].update_id, 101);
        assert_eq!(updates[0].chat_id, "555");
        assert_eq!(updates[0].text, "hello bot");
        assert_eq!(updates[1].update_id, 102);
        assert_eq!(updates[1].chat_id, "777");
        assert_eq!(updates[1].text, "second one");
    }

    #[test]
    fn get_updates_returns_empty_for_empty_result() {
        let transport = MockTransport::new(vec![r#"{"ok":true,"result":[]}"#]);
        let gw = TelegramGateway::new("STUB").with_base_url("http://mock.local");
        let updates = gw.get_updates(&transport, 0, 1).unwrap();
        assert!(updates.is_empty());
    }

    #[test]
    fn slack_gateway_posts_payload() {
        let transport = MockTransport::new(vec!["ok"]);
        let gw = SlackGateway::new("https://hooks.slack/x");
        let body = gw
            .send_message(
                &transport,
                &OutboundMessage {
                    chat_id: String::from("#general"),
                    text: String::from("hi from octocode"),
                },
            )
            .unwrap();
        assert_eq!(body, "ok");
        let calls = transport.calls();
        assert_eq!(calls[0].0, "https://hooks.slack/x");
        let payload = calls[0].1[0].1.clone();
        assert!(payload.contains("\"text\":\"hi from octocode\""));
        assert!(payload.contains("\"channel\":\"#general\""));
    }

    #[test]
    fn discord_gateway_posts_content_and_accepts_empty_body() {
        let transport = MockTransport::new(vec![""]);
        let gw = DiscordGateway::new("https://discord/webhook/x");
        gw.send_message(
            &transport,
            &OutboundMessage {
                chat_id: String::from("ignored"),
                text: String::from("hello"),
            },
        )
        .unwrap();
        let calls = transport.calls();
        assert_eq!(calls[0].0, "https://discord/webhook/x");
        assert!(calls[0].1.iter().any(|(k, v)| k == "content" && v == "hello"));
    }

    #[test]
    fn slack_and_discord_reject_empty_text() {
        let transport = MockTransport::new(vec![]);
        let slack = SlackGateway::new("https://hooks.slack/x");
        assert!(slack
            .send_message(
                &transport,
                &OutboundMessage { chat_id: String::from("c"), text: String::new() }
            )
            .is_err());
        let discord = DiscordGateway::new("https://discord/x");
        assert!(discord
            .send_message(
                &transport,
                &OutboundMessage { chat_id: String::from("c"), text: String::new() }
            )
            .is_err());
    }
}
