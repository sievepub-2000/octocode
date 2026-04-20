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
    let mut calls = Vec::new();
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
        if let Some(parsed) = parse_embedded_tool_call(block) {
            calls.push(parsed);
        }
        remaining = rest;
    }

    calls
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

    match base.as_str() {
        "write-file" | "writefile" => Some(String::from("write-file")),
        "create-file" | "createfile" => Some(String::from("create-file")),
        "append-file" | "appendfile" => Some(String::from("append-file")),
        "read-file" | "readfile" => Some(String::from("read-file")),
        "list-files" | "listdir" | "list-directory" => Some(String::from("list-files")),
        "move-file" | "movefile" | "rename-file" => Some(String::from("move-file")),
        "delete-file" | "deletefile" => Some(String::from("delete-file")),
        "search-text" | "searchtext" | "search" => Some(String::from("search-text")),
        "shell-command" | "shell" | "run-shell" | "run-command" | "exec" => {
            Some(String::from("shell-command"))
        }
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
}
