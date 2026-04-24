use std::collections::BTreeMap;

use octocode_core::{PermissionMode, ToolCall};

pub(crate) const TOOL_CALL_START_MARKER: &str = "<|tool_call>";
pub(crate) const TOOL_CALL_END_MARKER: &str = "<tool_call|>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EmbeddedToolCall {
    pub tool_name: String,
    pub arguments: BTreeMap<String, String>,
}

impl EmbeddedToolCall {
    pub fn to_tool_call(&self) -> Option<ToolCall> {
        let input = match self.tool_name.as_str() {
            "write-file" | "create-file" | "append-file" => format!(
                "{}|{}",
                self.argument(&["path", "file", "file_path"])?,
                self.argument(&["content", "contents", "text"])?,
            ),
            "read-file" | "delete-file" => self.argument(&["path", "file", "file_path"])?,
            "list-files" => self
                .argument(&["path", "dir", "directory"])
                .unwrap_or_default(),
            "move-file" => format!(
                "{}|{}",
                self.argument(&["src", "source", "from"])?,
                self.argument(&["dst", "dest", "destination", "to"])?,
            ),
            "shell-command" => self.argument(&["command", "cmd", "input"])?,
            "search-text" => {
                let pattern = self.argument(&["pattern", "query", "text"])?;
                match self.argument(&["path", "location"]) {
                    Some(path) if !path.trim().is_empty() => format!("{}|{}", pattern, path),
                    _ => pattern,
                }
            }
            _ => return None,
        };

        Some(ToolCall {
            name: self.tool_name.clone(),
            input,
            permission: PermissionMode::ReadOnly,
        })
    }

    fn argument(&self, names: &[&str]) -> Option<String> {
        names
            .iter()
            .find_map(|name| self.arguments.get(*name).cloned())
    }
}

pub(crate) fn parse_embedded_tool_calls(output: &str) -> Vec<EmbeddedToolCall> {
    parse_embedded_tool_calls_ext(output).0
}

/// P13-A: sibling of [`parse_embedded_tool_calls`] that additionally
/// returns the raw tool names of blocks we could not canonicalize (i.e.
/// tool names the runtime does not know about). Callers that only care
/// about the executable calls should keep using
/// `parse_embedded_tool_calls`; callers that want to report "the model
/// tried to call X" to operators use this variant.
pub(crate) fn parse_embedded_tool_calls_ext(output: &str) -> (Vec<EmbeddedToolCall>, Vec<String>) {
    let mut calls = Vec::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut remaining = output;

    while let Some(start) = remaining.find(TOOL_CALL_START_MARKER) {
        let block_start = start + TOOL_CALL_START_MARKER.len();
        let tail = &remaining[block_start..];
        let (block, rest) = if let Some(end) = tail.find(TOOL_CALL_END_MARKER) {
            (&tail[..end], &tail[end + TOOL_CALL_END_MARKER.len()..])
        } else if let Some(next_start) = tail.find(TOOL_CALL_START_MARKER) {
            (&tail[..next_start], &tail[next_start..])
        } else {
            (tail, "")
        };
        match parse_embedded_tool_call(block) {
            Some(parsed) => calls.push(parsed),
            None => {
                if let Some(name) = peek_raw_tool_name(block) {
                    blocked.push(name);
                }
            }
        }
        remaining = rest;
    }

    (calls, blocked)
}

/// Extract the raw textual tool name from a `<|tool_call>NAME(...)<tool_call|>`
/// block without running canonicalization. Used to surface blocked tool
/// names to operators. Returns `None` for malformed blocks (no `(`).
fn peek_raw_tool_name(block: &str) -> Option<String> {
    let trimmed = block.trim().trim_end_matches(';').trim();
    let open = trimmed.find('(')?;
    let raw = trimmed[..open].trim();
    // Strip the same non-alphanumeric prefixes that
    // canonicalize_embedded_tool_name would before deciding; this makes
    // the reported name match what the model actually typed.
    let cleaned: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_ascii_lowercase().replace('_', "-"))
    }
}

pub(crate) fn strip_embedded_tool_calls(output: &str) -> String {
    let mut stripped = String::new();
    let mut remaining = output;

    while let Some(start) = remaining.find(TOOL_CALL_START_MARKER) {
        stripped.push_str(&remaining[..start]);
        let block_start = start + TOOL_CALL_START_MARKER.len();
        let tail = &remaining[block_start..];
        if let Some(end) = tail.find(TOOL_CALL_END_MARKER) {
            remaining = &tail[end + TOOL_CALL_END_MARKER.len()..];
        } else {
            remaining = "";
            break;
        }
    }

    stripped.push_str(remaining);
    stripped
}

pub(crate) fn summarize_tool_execution_response(output: &str, reports: &[String]) -> String {
    let visible = strip_embedded_tool_calls(output).trim().to_string();
    let headline = if visible.is_empty() {
        String::from("done")
    } else {
        visible
    };
    let suffix = reports
        .iter()
        .map(|report| format!("- {report}"))
        .collect::<Vec<_>>()
        .join("\n");

    if suffix.is_empty() {
        headline
    } else {
        format!(
            "{}\n\nExecuted {} tool {}.\n{}",
            headline,
            reports.len(),
            if reports.len() == 1 { "call" } else { "calls" },
            suffix,
        )
    }
}

fn parse_embedded_tool_call(block: &str) -> Option<EmbeddedToolCall> {
    let trimmed = block.trim().trim_end_matches(';').trim();
    let open = trimmed.find('(')?;
    let close = trimmed.rfind(')')?;
    if close <= open {
        return None;
    }

    let tool_name = canonicalize_embedded_tool_name(&trimmed[..open])?;
    let arguments = parse_embedded_tool_arguments(&trimmed[open + 1..close])?;
    Some(EmbeddedToolCall {
        tool_name,
        arguments,
    })
}

fn canonicalize_embedded_tool_name(raw_name: &str) -> Option<String> {
    let base = raw_name
        .trim()
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
        .rfind(|part: &&str| !part.is_empty())
        .unwrap_or(raw_name)
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-");

    // Some models (Gemma/Qwen variants) wrap the actual tool name with a
    // `tool-` / `call-` / `function-` prefix, e.g. `tool-create-file`.
    // Strip a single leading marker so the canonical match below succeeds.
    let base = base
        .strip_prefix("tool-")
        .or_else(|| base.strip_prefix("call-"))
        .or_else(|| base.strip_prefix("function-"))
        .map(|s| s.to_string())
        .unwrap_or(base);

    match base.as_str() {
        "write-file" | "writefile" => Some(String::from("write-file")),
        "create-file" | "createfile" | "new-file" => Some(String::from("create-file")),
        "append-file" | "appendfile" => Some(String::from("append-file")),
        "read-file" | "readfile" | "cat-file" => Some(String::from("read-file")),
        "list-files" | "listdir" | "list-directory" | "ls" => Some(String::from("list-files")),
        "move-file" | "movefile" | "rename-file" | "mv" => Some(String::from("move-file")),
        "delete-file" | "deletefile" | "remove-file" | "rm" => Some(String::from("delete-file")),
        "search-text" | "searchtext" | "search" | "grep" => Some(String::from("search-text")),
        "shell-command" | "shell" | "run-shell" | "run-command" | "exec" | "bash" => {
            Some(String::from("shell-command"))
        }
        "web-search" | "websearch" => Some(String::from("web-search")),
        _ => None,
    }
}

fn parse_embedded_tool_arguments(input: &str) -> Option<BTreeMap<String, String>> {
    let mut arguments = BTreeMap::new();
    let mut index = 0usize;

    loop {
        skip_tool_argument_separators(input, &mut index);
        if index >= input.len() {
            break;
        }

        let key = parse_tool_argument_key(input, &mut index)?;
        skip_tool_argument_whitespace(input, &mut index);
        if input[index..].chars().next()? != '=' {
            return None;
        }
        index += '='.len_utf8();
        skip_tool_argument_whitespace(input, &mut index);

        let value = parse_tool_argument_value(input, &mut index)?;
        arguments.insert(key, value);

        skip_tool_argument_whitespace(input, &mut index);
        if index < input.len() && input[index..].starts_with(',') {
            index += ','.len_utf8();
        }
    }

    Some(arguments)
}

fn skip_tool_argument_separators(input: &str, index: &mut usize) {
    while *index < input.len() {
        let Some(ch) = input[*index..].chars().next() else {
            break;
        };
        if ch.is_whitespace() || ch == ',' {
            *index += ch.len_utf8();
            continue;
        }
        break;
    }
}

fn skip_tool_argument_whitespace(input: &str, index: &mut usize) {
    while *index < input.len() {
        let Some(ch) = input[*index..].chars().next() else {
            break;
        };
        if ch.is_whitespace() {
            *index += ch.len_utf8();
            continue;
        }
        break;
    }
}

fn parse_tool_argument_key(input: &str, index: &mut usize) -> Option<String> {
    let start = *index;
    while *index < input.len() {
        let ch = input[*index..].chars().next()?;
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            *index += ch.len_utf8();
            continue;
        }
        break;
    }
    if *index == start {
        return None;
    }
    Some(input[start..*index].to_ascii_lowercase())
}

fn parse_tool_argument_value(input: &str, index: &mut usize) -> Option<String> {
    let quote = input[*index..].chars().next()?;
    if quote == '"' || quote == '\'' {
        return parse_quoted_tool_argument_value(input, index, quote);
    }

    let start = *index;
    while *index < input.len() {
        let ch = input[*index..].chars().next()?;
        if ch == ',' {
            break;
        }
        *index += ch.len_utf8();
    }
    Some(input[start..*index].trim().to_string())
}

fn parse_quoted_tool_argument_value(
    input: &str,
    index: &mut usize,
    quote: char,
) -> Option<String> {
    *index += quote.len_utf8();
    let mut value = String::new();
    let mut escaped = false;

    while *index < input.len() {
        let ch = input[*index..].chars().next()?;
        *index += ch.len_utf8();

        if escaped {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '"' => '"',
                '\'' => '\'',
                other => other,
            });
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == quote {
            return Some(value);
        }

        value.push(ch);
    }

    None
}

/// P10-A: Unified translator that converts an assistant's free-form reply
/// into a vector of structured `ToolCall`s.
///
/// This is the **canonical entry point** the coordinator should call on every
/// assistant text turn. It subsumes:
/// * The structured `<|tool_call>...<tool_call|>` parser that already backs
///   `parse_embedded_tool_calls` (handles Qwen / XML-style dialects).
/// * The P8 `scan_text_tool_call` marker scanner that covers DeepSeek
///   (`<|tool_calls_begin|>`) and Llama-3 (`<|python_tag|>`) dialects,
///   used as a belt-and-suspenders fallback.
///
/// Contract:
/// * Returns an empty `Vec` for plain prose or empty input.
/// * Never panics. Never performs I/O.
/// * Does **not** deduplicate — callers that need dedup (e.g. to avoid
///   running the same file-read twice in one turn) are responsible for it.
/// * Tool names that are not in the runtime catalog are dropped silently,
///   since there is no safe way to execute them.
pub fn translate_text_tool_calls(text: &str) -> Vec<octocode_core::ToolCall> {
    translate_text_tool_calls_with_report(text).calls
}

/// P13-A: A structured result describing what happened when we translated
/// an assistant reply. `calls` are the executable tool calls that survived
/// the runtime catalog check. `blocked` captures the raw tool names that
/// the model tried to invoke but were either unknown or non-canonicalizable.
///
/// This is the primitive the coordinator uses to emit `tool_blocked`
/// entries on the event feed, so WebUI operators can see "the model tried
/// to call tool X and was denied". We never execute blocked names — this
/// is purely an observability win.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ToolCallTranslation {
    pub calls: Vec<octocode_core::ToolCall>,
    pub blocked: Vec<String>,
}

/// P13-A: Instrumented sibling of [`translate_text_tool_calls`]. Returns
/// both the executable calls and the list of tool names that were dropped
/// because they are not in the runtime catalog. The coordinator is free
/// to log / event-feed the blocked names; this function itself performs
/// no I/O and never panics.
pub fn translate_text_tool_calls_with_report(text: &str) -> ToolCallTranslation {
    if text.is_empty() {
        return ToolCallTranslation::default();
    }
    let mut calls: Vec<octocode_core::ToolCall> = Vec::new();
    let mut blocked: Vec<String> = Vec::new();

    // Path 1: structured `<|tool_call>...(k=v, ...)<tool_call|>` blocks.
    let (embedded_calls, embedded_blocked) = parse_embedded_tool_calls_ext(text);
    blocked.extend(embedded_blocked);
    for embedded in embedded_calls {
        let raw_name = embedded.tool_name.clone();
        match embedded.to_tool_call() {
            Some(call) => calls.push(call),
            None => blocked.push(raw_name),
        }
    }

    // Path 2: only consult the loose marker scanner when the structured
    // parser produced nothing. The scanner is intentionally less precise
    // and should not compete with the structured path.
    if calls.is_empty() {
        if let Some((name, raw_args)) = crate::tools::scan_text_tool_call(text) {
            let canonical = canonicalize_embedded_tool_name(&name);
            match canonical {
                Some(canonical_name) => {
                    if let Some(parsed) = parse_embedded_tool_arguments(&raw_args) {
                        let synthetic = EmbeddedToolCall {
                            tool_name: canonical_name.clone(),
                            arguments: parsed,
                        };
                        match synthetic.to_tool_call() {
                            Some(call) => calls.push(call),
                            None => blocked.push(canonical_name),
                        }
                    } else {
                        blocked.push(canonical_name);
                    }
                }
                None => blocked.push(name),
            }
        }
    }

    ToolCallTranslation { calls, blocked }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_single_tool_call() {
        let output = r#"Let me read the file.
<|tool_call>read-file(path="src/main.rs")<tool_call|>
Done."#;
        let calls = parse_embedded_tool_calls(output);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].tool_name, "read-file");
        assert_eq!(calls[0].arguments.get("path"), Some(&String::from("src/main.rs")));
    }

    #[test]
    fn test_parse_multiple_tool_calls() {
        let output = r#"I'll read two files.
<|tool_call>read-file(path="a.rs")<tool_call|>
<|tool_call>read-file(path="b.rs")<tool_call|>
That's all."#;
        let calls = parse_embedded_tool_calls(output);
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn test_parse_write_file() {
        let output = r#"<|tool_call>write-file(path="test.txt", content="hello world")<tool_call|>"#;
        let calls = parse_embedded_tool_calls(output);
        assert_eq!(calls.len(), 1);
        let call = calls[0].to_tool_call().unwrap();
        assert_eq!(call.name, "write-file");
        assert_eq!(call.input, "test.txt|hello world");
    }

    #[test]
    fn test_parse_shell_command() {
        let output = r#"<|tool_call>shell-command(command="cargo test")<tool_call|>"#;
        let calls = parse_embedded_tool_calls(output);
        assert_eq!(calls.len(), 1);
        let call = calls[0].to_tool_call().unwrap();
        assert_eq!(call.name, "shell-command");
        assert_eq!(call.input, "cargo test");
    }

    #[test]
    fn test_parse_search_text_with_path() {
        let output = r#"<|tool_call>search-text(pattern="fn main", path="src")<tool_call|>"#;
        let calls = parse_embedded_tool_calls(output);
        let call = calls[0].to_tool_call().unwrap();
        assert_eq!(call.name, "search-text");
        assert_eq!(call.input, "fn main|src");
    }

    #[test]
    fn test_parse_move_file() {
        let output = r#"<|tool_call>move-file(src="old.rs", dst="new.rs")<tool_call|>"#;
        let calls = parse_embedded_tool_calls(output);
        let call = calls[0].to_tool_call().unwrap();
        assert_eq!(call.name, "move-file");
        assert_eq!(call.input, "old.rs|new.rs");
    }

    #[test]
    fn test_strip_embedded_tool_calls() {
        let output = "before <|tool_call>read-file(path=\"x\")<tool_call|> after";
        let stripped = strip_embedded_tool_calls(output);
        assert_eq!(stripped, "before  after");
    }

    #[test]
    fn test_no_tool_calls() {
        let output = "Just a regular message without any tool calls.";
        let calls = parse_embedded_tool_calls(output);
        assert!(calls.is_empty());
    }

    #[test]
    fn test_summarize_tool_execution_response() {
        let output = "Some text <|tool_call>read-file(path=\"x\")<tool_call|>";
        let reports = vec!["[read-file] contents of x".into()];
        let summary = summarize_tool_execution_response(output, &reports);
        assert!(summary.contains("Some text"));
        assert!(summary.contains("[read-file] contents of x"));
        assert!(summary.contains("1 tool call"));
    }

    #[test]
    fn test_canonicalize_embedded_tool_name_aliases() {
        assert_eq!(canonicalize_embedded_tool_name("writefile"), Some("write-file".into()));
        assert_eq!(canonicalize_embedded_tool_name("readFile"), Some("read-file".into()));
        assert_eq!(canonicalize_embedded_tool_name("exec"), Some("shell-command".into()));
        assert_eq!(canonicalize_embedded_tool_name("listdir"), Some("list-files".into()));
        assert_eq!(canonicalize_embedded_tool_name("unknown_tool"), None);
    }

    #[test]
    fn test_canonicalize_strips_tool_prefix_variants() {
        // Some models emit `tool-create-file(...)` or `call-read-file(...)`;
        // we strip a single leading marker so the canonical match succeeds.
        assert_eq!(
            canonicalize_embedded_tool_name("tool-create-file"),
            Some("create-file".into())
        );
        assert_eq!(
            canonicalize_embedded_tool_name("tool_read_file"),
            Some("read-file".into())
        );
        assert_eq!(
            canonicalize_embedded_tool_name("call-shell-command"),
            Some("shell-command".into())
        );
        assert_eq!(
            canonicalize_embedded_tool_name("function-delete-file"),
            Some("delete-file".into())
        );
    }

    #[test]
    fn test_escaped_quotes_in_arguments() {
        let output = r#"<|tool_call>write-file(path="test.rs", content="let x = \"hello\";")<tool_call|>"#;
        let calls = parse_embedded_tool_calls(output);
        assert_eq!(calls.len(), 1);
        let content = calls[0].arguments.get("content").unwrap();
        assert!(content.contains("\"hello\""));
    }

    #[test]
    fn test_to_tool_call_unknown_returns_none() {
        let call = EmbeddedToolCall {
            tool_name: "nonexistent-tool".into(),
            arguments: BTreeMap::new(),
        };
        assert!(call.to_tool_call().is_none());
    }

    #[test]
    fn test_to_tool_call_missing_required_args_returns_none() {
        let call = EmbeddedToolCall {
            tool_name: "write-file".into(),
            arguments: BTreeMap::new(), // Missing path and content
        };
        assert!(call.to_tool_call().is_none());
    }

    // P10: unified translator tests

    #[test]
    fn translate_handles_qwen_marker_and_canonicalizes_args() {
        // Qwen-style: write-file with explicit path + content arguments.
        let text = r#"<|tool_call>write-file(path="hello.rs", content="fn main() {}")<tool_call|>"#;
        let calls = super::translate_text_tool_calls(text);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "write-file");
        assert!(calls[0].input.contains("hello.rs"));
        assert!(calls[0].input.contains("fn main()"));
    }

    #[test]
    fn translate_handles_xml_style_tool_call_marker() {
        // Some providers use `<tool_call>...<tool_call|>` (xml-ish closer).
        let text = r#"<tool_call>read-file(path="Cargo.toml")<tool_call|>"#;
        let calls = super::translate_text_tool_calls(text);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read-file");
        assert_eq!(calls[0].input, "Cargo.toml");
    }

    #[test]
    fn translate_returns_empty_for_plain_prose() {
        let calls = super::translate_text_tool_calls("Just a normal assistant reply.");
        assert!(calls.is_empty());
    }

    #[test]
    fn translate_returns_empty_for_empty_string() {
        let calls = super::translate_text_tool_calls("");
        assert!(calls.is_empty());
    }

    #[test]
    fn translate_deduplicates_identical_calls() {
        let text = concat!(
            r#"<|tool_call>read-file(path="a.rs")<tool_call|>"#,
            r#"<|tool_call>read-file(path="a.rs")<tool_call|>"#,
        );
        let calls = super::translate_text_tool_calls(text);
        // Two identical calls are both surfaced; dedup is left to downstream.
        // This test locks in the "no dedup at translator layer" contract.
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn translate_handles_multiple_heterogeneous_calls_in_sequence() {
        let text = concat!(
            r#"<|tool_call>read-file(path="a.rs")<tool_call|>"#,
            "ok now write ",
            r#"<|tool_call>write-file(path="b.rs", content="done")<tool_call|>"#,
        );
        let calls = super::translate_text_tool_calls(text);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read-file");
        assert_eq!(calls[1].name, "write-file");
    }

    #[test]
    fn translate_skips_unknown_tool_names_silently() {
        // `canonicalize_embedded_tool_name` returns None for unknown tools,
        // so they must not produce a ToolCall.
        let text = r#"<|tool_call>nonexistent-tool(path="x")<tool_call|>"#;
        let calls = super::translate_text_tool_calls(text);
        assert!(calls.is_empty());
    }

    #[test]
    fn translate_with_report_captures_blocked_names() {
        // P13-A: unknown tool names must surface in the `blocked` list so
        // the coordinator can emit a `tool_blocked` event on the feed.
        let text = r#"<|tool_call>nonexistent-tool(path="x")<tool_call|>"#;
        let report = super::translate_text_tool_calls_with_report(text);
        assert!(report.calls.is_empty(), "blocked tools must not execute");
        assert_eq!(report.blocked, vec!["nonexistent-tool".to_string()]);
    }

    #[test]
    fn translate_with_report_mixes_valid_and_blocked() {
        // A valid call alongside a blocked one: valid call executes,
        // blocked name is reported, neither interferes with the other.
        let text = concat!(
            r#"<|tool_call>read-file(path="a.rs")<tool_call|>"#,
            r#"<|tool_call>evil-backdoor(cmd="rm -rf /")<tool_call|>"#,
        );
        let report = super::translate_text_tool_calls_with_report(text);
        assert_eq!(report.calls.len(), 1);
        assert_eq!(report.calls[0].name, "read-file");
        assert_eq!(report.blocked, vec!["evil-backdoor".to_string()]);
    }

    #[test]
    fn translate_with_report_empty_for_plain_prose() {
        let report = super::translate_text_tool_calls_with_report("hello, no tools here");
        assert!(report.calls.is_empty());
        assert!(report.blocked.is_empty());
    }
}

