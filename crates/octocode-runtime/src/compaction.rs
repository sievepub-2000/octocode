use octocode_core::{ConversationMessage, ConversationRole};

/// Configuration thresholds for context compaction.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Estimated token threshold to trigger compaction.
    pub token_threshold: usize,
    /// Number of recent messages to always preserve (never compacted).
    pub preserve_recent: usize,
    /// Maximum characters for a compacted summary.
    pub summary_budget_chars: usize,
    /// Maximum lines for a compacted summary.
    pub summary_budget_lines: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            token_threshold: 100_000,
            preserve_recent: 6,
            summary_budget_chars: 1200,
            summary_budget_lines: 24,
        }
    }
}

/// Result of a compaction operation.
#[derive(Debug, Clone)]
pub struct CompactionResult {
    /// The compacted conversation (summary + preserved recent messages).
    pub messages: Vec<ConversationMessage>,
    /// Number of messages that were compacted into the summary.
    pub compacted_count: usize,
    /// Estimated tokens before compaction.
    pub tokens_before: usize,
    /// Estimated tokens after compaction.
    pub tokens_after: usize,
}

/// Rough token estimation accounting for CJK characters.
/// English: ~4 chars per token. CJK/emoji: ~1.5 chars per token.
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk_chars = 0usize;
    let mut ascii_chars = 0usize;
    for ch in text.chars() {
        if ch > '\u{2E7F}' {
            // CJK Unified Ideographs, Katakana, Hiragana, etc.
            cjk_chars += 1;
        } else {
            ascii_chars += 1;
        }
    }
    // CJK chars average ~1.5 tokens each, ASCII ~0.25 tokens each
    let cjk_tokens = (cjk_chars * 3).div_ceil(2);
    let ascii_tokens = ascii_chars.div_ceil(4);
    cjk_tokens + ascii_tokens
}

/// Estimate total tokens across all messages in a conversation.
pub fn estimate_conversation_tokens(messages: &[ConversationMessage]) -> usize {
    messages.iter().map(|m| estimate_tokens(&m.content) + 4).sum()
}

/// Check if a conversation should be compacted.
pub fn should_compact(messages: &[ConversationMessage], config: &CompactionConfig) -> bool {
    let total_tokens = estimate_conversation_tokens(messages);
    total_tokens > config.token_threshold && messages.len() > config.preserve_recent + 2
}

/// Compact a conversation by summarizing older messages and preserving recent ones.
///
/// The summary is generated locally (no LLM call) by extracting key content
/// from older messages and truncating to the budget.
pub fn compact_conversation(
    messages: &[ConversationMessage],
    config: &CompactionConfig,
) -> CompactionResult {
    let tokens_before = estimate_conversation_tokens(messages);

    if messages.len() <= config.preserve_recent + 1 {
        return CompactionResult {
            messages: messages.to_vec(),
            compacted_count: 0,
            tokens_before,
            tokens_after: tokens_before,
        };
    }

    let split_point = messages.len().saturating_sub(config.preserve_recent);
    let older = &messages[..split_point];
    let recent = &messages[split_point..];

    let summary = build_summary(older, config);
    let compacted_count = older.len();

    let mut result = Vec::with_capacity(1 + recent.len());
    result.push(ConversationMessage {
        role: ConversationRole::System,
        content: format!(
            "[Context compacted: {} messages summarized]\n{}",
            compacted_count, summary
        ),
    });
    result.extend_from_slice(recent);

    let tokens_after = estimate_conversation_tokens(&result);

    CompactionResult {
        messages: result,
        compacted_count,
        tokens_before,
        tokens_after,
    }
}

/// Build a local summary of older messages within the budget constraints.
fn build_summary(messages: &[ConversationMessage], config: &CompactionConfig) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut total_chars = 0usize;

    for msg in messages {
        if lines.len() >= config.summary_budget_lines {
            break;
        }
        if total_chars >= config.summary_budget_chars {
            break;
        }

        let prefix = match msg.role {
            ConversationRole::User => "U",
            ConversationRole::Assistant => "A",
            ConversationRole::System => "S",
            ConversationRole::Tool => "T",
        };

        // Take the first meaningful line of the message
        let first_line = msg
            .content
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");

        let max_line_chars = 160;
        let truncated = if first_line.len() > max_line_chars {
            let mut end = max_line_chars;
            while end > 0 && !first_line.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &first_line[..end])
        } else {
            first_line.to_string()
        };

        let line = format!("[{prefix}] {truncated}");
        total_chars += line.len();
        lines.push(line);
    }

    lines.join("\n")
}

/// Extract durable memories from a conversation.
///
/// Scans assistant messages for patterns that indicate important facts:
/// - Lines starting with "Note:", "Important:", "Remember:"
/// - Tool results with file paths
/// - Decision points and conclusions
pub fn extract_memories(messages: &[ConversationMessage]) -> Vec<String> {
    let mut memories = Vec::new();
    let keywords = ["note:", "important:", "remember:", "decision:", "conclusion:"];

    for msg in messages {
        let is_memory_source = msg.role == ConversationRole::Assistant
            || (msg.role == ConversationRole::System && msg.content.contains("[Session memory]"));
        if !is_memory_source {
            continue;
        }
        for line in msg.content.lines() {
            let lower = line.trim().to_lowercase();
            if keywords.iter().any(|kw| lower.starts_with(kw)) {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() && trimmed.len() < 500 {
                    memories.push(trimmed);
                }
            }
        }
    }

    memories
}

/// Generate a brief session summary for resumption (1-3 sentences).
pub fn away_summary(messages: &[ConversationMessage]) -> String {
    if messages.is_empty() {
        return String::from("Empty session.");
    }

    let user_count = messages.iter().filter(|m| m.role == ConversationRole::User).count();
    let assistant_count = messages.iter().filter(|m| m.role == ConversationRole::Assistant).count();

    let last_user = messages
        .iter()
        .rev()
        .find(|m| m.role == ConversationRole::User)
        .map(|m| {
            let first_line = m.content.lines().next().unwrap_or("");
            if first_line.len() > 100 {
                format!("{}...", &first_line[..100])
            } else {
                first_line.to_string()
            }
        })
        .unwrap_or_default();

    let tokens = estimate_conversation_tokens(messages);

    format!(
        "Session with {user_count} user and {assistant_count} assistant messages (~{tokens} tokens). Last topic: {last_user}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_msg(role: ConversationRole, content: &str) -> ConversationMessage {
        ConversationMessage {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn estimate_tokens_basic() {
        // 5 ascii chars → ceil(5/4) = 2
        assert_eq!(estimate_tokens("hello"), 2);
        assert_eq!(estimate_tokens(""), 0);
        // 400 ascii chars → 100 tokens
        assert!(estimate_tokens(&"a".repeat(400)) == 100);
    }

    #[test]
    fn estimate_tokens_cjk() {
        // CJK chars should count as ~1.5 tokens each
        let cjk = "你好世界"; // 4 CJK chars → 4*3/2 = 6 tokens
        assert_eq!(estimate_tokens(cjk), 6);
    }

    #[test]
    fn estimate_tokens_mixed() {
        // "hello你好" = 5 ascii (ceil(5/4)=2) + 2 CJK (2*3/2=3) = 5
        assert_eq!(estimate_tokens("hello你好"), 5);
    }

    #[test]
    fn should_compact_below_threshold() {
        let config = CompactionConfig {
            token_threshold: 1000,
            ..Default::default()
        };
        let messages = vec![
            make_msg(ConversationRole::User, "hello"),
            make_msg(ConversationRole::Assistant, "hi"),
        ];
        assert!(!should_compact(&messages, &config));
    }

    #[test]
    fn should_compact_above_threshold() {
        let config = CompactionConfig {
            token_threshold: 10,
            preserve_recent: 2,
            ..Default::default()
        };
        let messages: Vec<_> = (0..20)
            .map(|i| make_msg(ConversationRole::User, &format!("message number {i} with some content to push tokens")))
            .collect();
        assert!(should_compact(&messages, &config));
    }

    #[test]
    fn compact_preserves_recent() {
        let config = CompactionConfig {
            token_threshold: 10,
            preserve_recent: 3,
            summary_budget_chars: 500,
            summary_budget_lines: 10,
        };
        let messages: Vec<_> = (0..10)
            .map(|i| make_msg(ConversationRole::User, &format!("message {i}")))
            .collect();
        let result = compact_conversation(&messages, &config);
        // Should have 1 summary + 3 recent = 4 messages
        assert_eq!(result.messages.len(), 4);
        assert_eq!(result.compacted_count, 7);
        assert!(result.messages[0].content.contains("Context compacted"));
        assert!(result.tokens_after < result.tokens_before);
    }

    #[test]
    fn compact_small_conversation_unchanged() {
        let config = CompactionConfig {
            preserve_recent: 6,
            ..Default::default()
        };
        let messages = vec![
            make_msg(ConversationRole::User, "hello"),
            make_msg(ConversationRole::Assistant, "hi"),
        ];
        let result = compact_conversation(&messages, &config);
        assert_eq!(result.compacted_count, 0);
        assert_eq!(result.messages.len(), 2);
    }

    #[test]
    fn extract_memories_finds_notes() {
        let messages = vec![
            make_msg(ConversationRole::User, "fix the bug"),
            make_msg(
                ConversationRole::Assistant,
                "Note: The issue was caused by a missing null check.\nI've fixed it.",
            ),
            make_msg(
                ConversationRole::Assistant,
                "Important: Always validate input at boundaries.",
            ),
        ];
        let memories = extract_memories(&messages);
        assert_eq!(memories.len(), 2);
        assert!(memories[0].contains("null check"));
        assert!(memories[1].contains("validate input"));
    }

    #[test]
    fn extract_memories_ignores_user_messages() {
        let messages = vec![
            make_msg(ConversationRole::User, "Note: this is user text"),
        ];
        let memories = extract_memories(&messages);
        assert!(memories.is_empty());
    }

    #[test]
    fn extract_memories_keeps_compacted_session_memory_lines() {
        let messages = vec![make_msg(
            ConversationRole::System,
            "[Session memory]\nRemember: Keep using ripgrep for repo search.\nImportant: Preserve the latest three messages.",
        )];
        let memories = extract_memories(&messages);
        assert_eq!(memories.len(), 2);
        assert!(memories[0].contains("ripgrep"));
        assert!(memories[1].contains("latest three messages"));
    }

    #[test]
    fn away_summary_format() {
        let messages = vec![
            make_msg(ConversationRole::User, "fix the login page"),
            make_msg(ConversationRole::Assistant, "I'll fix it now."),
            make_msg(ConversationRole::User, "also add dark mode"),
        ];
        let summary = away_summary(&messages);
        assert!(summary.contains("2 user"));
        assert!(summary.contains("1 assistant"));
        assert!(summary.contains("dark mode"));
    }

    #[test]
    fn away_summary_empty() {
        let summary = away_summary(&[]);
        assert_eq!(summary, "Empty session.");
    }
}
