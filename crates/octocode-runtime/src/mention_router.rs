//! Inbound `@mention` routing.
//!
//! Converts an [`InboundEvent`](octocode_gateway::InboundEvent) into a
//! [`MentionRoute`] that the runtime can act on: resume a specific
//! session id, continue the latest session for the sender, or drop the
//! event entirely. The router is closure-driven so the *how* of
//! looking up "latest session for this user" remains a runtime concern
//! and this module never touches storage directly.

#![allow(dead_code)]

use octocode_gateway::{parse_mention, InboundEvent, WebhookPlatform};

/// What the runtime should do with an inbound message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MentionRoute {
    /// Resume an existing session id and append `body` as the next user
    /// message.
    Resume { session_id: String, body: String },
    /// Continue the most recent session for `(platform, user_id)`. The
    /// runtime still appends `body` as the next user message.
    Continue { session_id: String, body: String },
    /// No actionable mention — discard.
    Drop,
}

/// Stateless router. The closure parameter resolves "latest session
/// id for `(platform, user_id)`" from the runtime's session store.
pub fn route_inbound<F>(event: &InboundEvent, latest_for_user: F) -> MentionRoute
where
    F: FnOnce(WebhookPlatform, &str) -> Option<String>,
{
    if let Some((session_id, body)) = parse_mention(&event.text) {
        return MentionRoute::Resume { session_id, body };
    }
    // No explicit mention. If the event is a direct message (chat_id
    // looks like a user id, not a channel), continue the latest session
    // for the sender; otherwise drop.
    if event.user_id.is_empty() {
        return MentionRoute::Drop;
    }
    match latest_for_user(event.platform, &event.user_id) {
        Some(session_id) => MentionRoute::Continue {
            session_id,
            body: event.text.clone(),
        },
        None => MentionRoute::Drop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(text: &str) -> InboundEvent {
        InboundEvent {
            platform: WebhookPlatform::Telegram,
            chat_id: String::from("c1"),
            user_id: String::from("u1"),
            text: text.to_string(),
        }
    }

    #[test]
    fn explicit_mention_routes_to_resume() {
        let route = route_inbound(
            &ev("hey @octocode session=abc do thing"),
            |_, _| Some(String::from("ignored")),
        );
        assert_eq!(
            route,
            MentionRoute::Resume {
                session_id: String::from("abc"),
                body: String::from("do thing"),
            }
        );
    }

    #[test]
    fn no_mention_falls_back_to_latest_session() {
        let route = route_inbound(&ev("hello"), |p, u| {
            assert_eq!(p, WebhookPlatform::Telegram);
            assert_eq!(u, "u1");
            Some(String::from("sess-9"))
        });
        assert_eq!(
            route,
            MentionRoute::Continue {
                session_id: String::from("sess-9"),
                body: String::from("hello"),
            }
        );
    }

    #[test]
    fn no_mention_and_no_latest_session_drops() {
        let route = route_inbound(&ev("hello"), |_, _| None);
        assert_eq!(route, MentionRoute::Drop);
    }

    #[test]
    fn empty_user_id_drops() {
        let mut event = ev("hello");
        event.user_id.clear();
        let route = route_inbound(&event, |_, _| Some(String::from("anything")));
        assert_eq!(route, MentionRoute::Drop);
    }
}
