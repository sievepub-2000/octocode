//! Inbound webhook router. Converts platform-specific JSON payloads
//! (Telegram update, Slack event, Discord interaction) into a unified
//! [`InboundEvent`] value the runtime can route to a session.
//!
//! This module is **transport-free**: it never opens a socket, listens
//! on a port, or trusts a header. The host process (e.g. the WebUI HTTP
//! server) is responsible for binding `/hook/<platform>` routes and
//! handing the raw body to `WebhookRouter::route`. The unit tests
//! exercise every path entirely offline.

use crate::extract_string_field_inner as extract_string_field;
use octocode_core::OctoError;

/// Source platform for an inbound event. Used by the runtime to choose
/// the corresponding outbound transport when replying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookPlatform {
    Telegram,
    Slack,
    Discord,
}

impl WebhookPlatform {
    pub fn as_str(&self) -> &'static str {
        match self {
            WebhookPlatform::Telegram => "telegram",
            WebhookPlatform::Slack => "slack",
            WebhookPlatform::Discord => "discord",
        }
    }
}

/// Unified inbound message shape. `chat_id` is the platform-native
/// channel/chat identifier; `user_id` is the sender's stable id (used
/// by the cross-session user model in `octocode-runtime`); `text` is
/// the user-visible message body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundEvent {
    pub platform: WebhookPlatform,
    pub chat_id: String,
    pub user_id: String,
    pub text: String,
}

/// Stateless parser that maps a `(platform, body)` pair into zero or
/// more inbound events. Slack URL verification challenges return an
/// `Ok(Vec::new())` plus a populated `challenge` field on the router so
/// the host can reply with the expected token.
#[derive(Debug, Default, Clone)]
pub struct WebhookRouter;

impl WebhookRouter {
    pub fn new() -> Self {
        Self
    }

    /// Route a raw JSON body. Returns the events extracted from the
    /// payload (typically zero or one).
    pub fn route(
        &self,
        platform: WebhookPlatform,
        body: &str,
    ) -> Result<Vec<InboundEvent>, OctoError> {
        match platform {
            WebhookPlatform::Telegram => parse_telegram(body),
            WebhookPlatform::Slack => parse_slack(body),
            WebhookPlatform::Discord => parse_discord(body),
        }
    }

    /// Slack URL-verification challenge extraction. The host should
    /// reply with the challenge token verbatim when this returns Some.
    pub fn slack_challenge<'a>(&self, body: &'a str) -> Option<String> {
        if !body.contains("\"type\"") || !body.contains("url_verification") {
            return None;
        }
        extract_string_field(body, "challenge")
    }
}

fn parse_telegram(body: &str) -> Result<Vec<InboundEvent>, OctoError> {
    if body.trim().is_empty() {
        return Err(OctoError::Runtime(String::from("telegram webhook body empty")));
    }
    let chat_id = extract_nested_id(body, "\"chat\"", "\"id\"").unwrap_or_default();
    let user_id = extract_nested_id(body, "\"from\"", "\"id\"").unwrap_or_default();
    let text = extract_string_field(body, "text").unwrap_or_default();
    if chat_id.is_empty() || text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![InboundEvent {
        platform: WebhookPlatform::Telegram,
        chat_id,
        user_id,
        text,
    }])
}

fn parse_slack(body: &str) -> Result<Vec<InboundEvent>, OctoError> {
    if body.trim().is_empty() {
        return Err(OctoError::Runtime(String::from("slack webhook body empty")));
    }
    // `event_callback` is the standard outer envelope. Inside it we
    // need `event.channel`, `event.user`, `event.text`.
    if !body.contains("event_callback") && !body.contains("\"event\"") {
        return Ok(Vec::new());
    }
    let chat_id = extract_string_field(body, "channel").unwrap_or_default();
    let user_id = extract_string_field(body, "user").unwrap_or_default();
    let text = extract_string_field(body, "text").unwrap_or_default();
    if chat_id.is_empty() || text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![InboundEvent {
        platform: WebhookPlatform::Slack,
        chat_id,
        user_id,
        text,
    }])
}

fn parse_discord(body: &str) -> Result<Vec<InboundEvent>, OctoError> {
    if body.trim().is_empty() {
        return Err(OctoError::Runtime(String::from("discord webhook body empty")));
    }
    // Discord `MESSAGE_CREATE` carries `channel_id`, `author.id`,
    // `content`. We look for those three keys.
    let chat_id = extract_string_field(body, "channel_id").unwrap_or_default();
    let user_id = extract_nested_id(body, "\"author\"", "\"id\"").unwrap_or_default();
    let text = extract_string_field(body, "content").unwrap_or_default();
    if chat_id.is_empty() || text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![InboundEvent {
        platform: WebhookPlatform::Discord,
        chat_id,
        user_id,
        text,
    }])
}

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

/// Detect an `@octocode session=<id> ...` mention. Returns the parsed
/// `(session_id, remaining_body)` tuple. Used by gateways to route an
/// inbound message into an existing session resume + reply flow.
pub fn parse_mention(text: &str) -> Option<(String, String)> {
    let needle = "@octocode";
    let idx = text.find(needle)?;
    let rest = &text[idx + needle.len()..];
    let rest = rest.trim_start();
    let session_kv = "session=";
    let after_session = rest.strip_prefix(session_kv)?;
    let end = after_session
        .find(|c: char| c.is_whitespace())
        .unwrap_or(after_session.len());
    let session_id = after_session[..end].trim();
    if session_id.is_empty() {
        return None;
    }
    let body = after_session[end..].trim().to_string();
    Some((session_id.to_string(), body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telegram_message_parses_into_inbound_event() {
        let body = r#"{"update_id":42,"message":{"message_id":7,
            "from":{"id":2222,"username":"alice"},
            "chat":{"id":555,"type":"private"},
            "text":"hello bot"}}"#;
        let events = WebhookRouter.route(WebhookPlatform::Telegram, body).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].platform, WebhookPlatform::Telegram);
        assert_eq!(events[0].chat_id, "555");
        assert_eq!(events[0].user_id, "2222");
        assert_eq!(events[0].text, "hello bot");
    }

    #[test]
    fn slack_event_callback_parses_channel_user_text() {
        let body = r#"{"type":"event_callback","team_id":"T1",
            "event":{"type":"message","channel":"C-XYZ","user":"U-9","text":"hi octocode"}}"#;
        let events = WebhookRouter.route(WebhookPlatform::Slack, body).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].platform, WebhookPlatform::Slack);
        assert_eq!(events[0].chat_id, "C-XYZ");
        assert_eq!(events[0].user_id, "U-9");
        assert_eq!(events[0].text, "hi octocode");
    }

    #[test]
    fn slack_url_verification_returns_challenge() {
        let body = r#"{"type":"url_verification","challenge":"abc123"}"#;
        let router = WebhookRouter;
        assert_eq!(router.slack_challenge(body).as_deref(), Some("abc123"));
        // url_verification has no event payload, so route returns no events.
        let events = router.route(WebhookPlatform::Slack, body).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn discord_message_create_parses_event() {
        let body = r#"{"id":"100","channel_id":"C-200",
            "author":{"id":"U-300","username":"bob"},
            "content":"howdy"}"#;
        let events = WebhookRouter.route(WebhookPlatform::Discord, body).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].platform, WebhookPlatform::Discord);
        assert_eq!(events[0].chat_id, "C-200");
        assert_eq!(events[0].user_id, "U-300");
        assert_eq!(events[0].text, "howdy");
    }

    #[test]
    fn empty_or_missing_payload_returns_no_events_or_error() {
        assert!(WebhookRouter.route(WebhookPlatform::Telegram, "").is_err());
        // Missing text field — yields no events, not an error, so the
        // host can ignore non-message events (typing notifications,
        // reactions, …) without crashing the listener.
        let body = r#"{"update_id":1,"chat":{"id":1}}"#;
        let events = WebhookRouter.route(WebhookPlatform::Telegram, body).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn parse_mention_extracts_session_id_and_body() {
        let (sid, body) = parse_mention("hey @octocode session=abc123 please run cargo check").unwrap();
        assert_eq!(sid, "abc123");
        assert_eq!(body, "please run cargo check");
    }

    #[test]
    fn parse_mention_returns_none_when_session_missing() {
        assert!(parse_mention("hey @octocode help me").is_none());
        assert!(parse_mention("no mention here").is_none());
    }
}
