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
        let spec = argspec_for(&self.tool_name)?;
        let input = encode_input(spec, &self.arguments)?;
        Some(ToolCall {
            name: self.tool_name.clone(),
            input,
            permission: PermissionMode::ReadOnly,
        })
    }

    #[allow(dead_code)]
    fn argument(&self, names: &[&str]) -> Option<String> {
        names
            .iter()
            .find_map(|name| self.arguments.get(*name).cloned())
    }
}

/// Per-tool argument schema. Each inner slice is a parameter slot with its
/// canonical name first and aliases after. The encoder joins the values
/// with `|` in declared order to produce the legacy pipe-form input that
/// `WorkspaceToolExecutor` expects.
struct ArgSpec {
    /// Required slot count. The first `required` slots must resolve to a
    /// non-empty argument, otherwise translation fails (the call is
    /// reported as blocked).
    required: usize,
    /// Whether the tool accepts a single free-text argument instead of
    /// keyed arguments. When true and keyed args are empty, the parser
    /// falls through the slot aliases to look for a positional value.
    params: &'static [&'static [&'static str]],
}

fn encode_input(
    spec: &ArgSpec,
    args: &BTreeMap<String, String>,
) -> Option<String> {
    if spec.params.is_empty() {
        return Some(String::new());
    }
    let mut resolved: Vec<Option<String>> = Vec::with_capacity(spec.params.len());
    for (idx, aliases) in spec.params.iter().enumerate() {
        let found = aliases.iter().find_map(|k| args.get(*k).cloned());
        if idx < spec.required && found.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
            return None;
        }
        resolved.push(found);
    }
    // Strip trailing unset optionals so tools that peek at `call.input` for
    // "empty" state keep working (e.g. list-files, file-tree).
    while resolved.len() > spec.required && resolved.last().map(|v| v.is_none()).unwrap_or(false) {
        resolved.pop();
    }
    let parts: Vec<String> = resolved
        .into_iter()
        .map(|v| v.unwrap_or_default())
        .collect();
    Some(parts.join("|"))
}

/// Resolve the canonical tool name + argument schema for an already-
/// canonicalized tool name. Returns `None` for tools the runtime does not
/// expose — those calls are reported as `blocked`.
fn argspec_for(canonical: &str) -> Option<&'static ArgSpec> {
    // Keep argument aliases permissive to absorb the common naming
    // variations across providers (Gemma/Qwen/DeepSeek/Llama tool JSON).
    // Canonical param keys match what `WorkspaceToolExecutor` expects when
    // splitting `call.input` on `|`.
    const P_PATH: &[&str] = &["path", "file", "file_path", "filepath", "target"];
    const P_CONTENT: &[&str] = &["content", "contents", "text", "body", "data"];
    const P_COMMAND: &[&str] = &["command", "cmd", "input", "script"];
    const P_QUERY: &[&str] = &["query", "q", "pattern", "text", "keyword"];
    const P_URL: &[&str] = &["url", "href", "link", "target"];
    const P_ID: &[&str] = &["id", "task_id", "todo_id", "team_id"];
    const P_SCOPE: &[&str] = &["scope"];
    const P_MEMID: &[&str] = &["id", "key", "name"];
    const P_MEMCONTENT: &[&str] = &["content", "text", "body", "note"];
    Some(match canonical {
        "echo" => &ArgSpec { required: 0, params: &[&["text", "input", "message"]] },
        "read-file" => &ArgSpec { required: 1, params: &[P_PATH] },
        "list-files" => &ArgSpec { required: 0, params: &[&["path", "dir", "directory"]] },
        "write-file" | "create-file" | "append-file" => &ArgSpec {
            required: 2,
            params: &[P_PATH, P_CONTENT],
        },
        "shell-command" => &ArgSpec { required: 1, params: &[P_COMMAND] },
        "search-text" => &ArgSpec {
            required: 1,
            params: &[&["pattern", "query", "text"], &["path", "location"]],
        },
        "workflow-plan" | "agent-action" => &ArgSpec {
            required: 0,
            params: &[&["input", "text", "task", "goal"]],
        },
        "git-status" | "git-diff" => &ArgSpec { required: 0, params: &[P_PATH] },
        "git-log" => &ArgSpec { required: 0, params: &[&["limit", "count", "n"]] },
        "file-tree" => &ArgSpec {
            required: 0,
            params: &[P_PATH, &["depth", "max_depth", "levels"]],
        },
        "http-get" => &ArgSpec { required: 1, params: &[P_URL] },
        "read-context" => &ArgSpec { required: 0, params: &[&["name", "kind", "target"]] },
        "delete-file" => &ArgSpec { required: 1, params: &[P_PATH] },
        "empty-recycle-bin" => &ArgSpec { required: 0, params: &[] },
        "move-file" => &ArgSpec {
            required: 2,
            params: &[
                &["src", "source", "from", "path"],
                &["dst", "dest", "destination", "to"],
            ],
        },
        "task-submit" => &ArgSpec {
            required: 1,
            params: &[&["label", "title", "text", "input"]],
        },
        "task-list" => &ArgSpec { required: 0, params: &[] },
        "web-browse" => &ArgSpec { required: 1, params: &[P_URL] },
        "cli-pipe" => &ArgSpec {
            required: 1,
            params: &[&["pipeline", "command", "cmd", "input"]],
        },
        "cargo-eval" => &ArgSpec {
            required: 1,
            params: &[&["command", "cmd", "input", "args"]],
        },
        "patch-file" => &ArgSpec {
            required: 3,
            params: &[&["old", "before", "search"], &["new", "after", "replace"], P_PATH],
        },
        "diagnostics" => &ArgSpec { required: 0, params: &[] },
        "http-post" => &ArgSpec {
            required: 2,
            params: &[P_URL, &["body", "content", "data"], &["content_type", "content-type", "mime"]],
        },
        "json-query" => &ArgSpec {
            required: 2,
            params: &[&["path", "pointer", "query"], &["json", "data", "content"]],
        },
        "process-list" => &ArgSpec {
            required: 0,
            params: &[&["filter", "pattern", "name"]],
        },
        "env-var" => &ArgSpec { required: 0, params: &[&["name", "key", "var"]] },
        "base64" => &ArgSpec {
            required: 2,
            params: &[&["mode", "action"], &["text", "input", "data"]],
        },
        "vector-search" => &ArgSpec {
            required: 1,
            params: &[P_QUERY, &["category", "scope"], &["top_n", "topN", "limit"]],
        },
        "vector-upsert" => &ArgSpec {
            required: 3,
            params: &[&["category", "scope"], &["content", "text", "body"], &["filename", "name", "id"]],
        },
        "team-create" => &ArgSpec {
            required: 2,
            params: &[&["goal", "name", "task"], &["roles", "agents", "members"]],
        },
        "team-list" => &ArgSpec { required: 0, params: &[] },
        "team-delete" | "team-status" => &ArgSpec { required: 1, params: &[P_ID] },
        "agent-message" => &ArgSpec {
            required: 3,
            params: &[&["from"], &["to"], &["content", "message", "text"]],
        },
        "todo-add" => &ArgSpec {
            required: 1,
            params: &[&["item", "text", "label", "content", "title"]],
        },
        "todo-list" => &ArgSpec { required: 0, params: &[] },
        "todo-done" => &ArgSpec { required: 1, params: &[P_ID] },
        "task-get" => &ArgSpec { required: 1, params: &[P_ID] },
        "web-search" => &ArgSpec { required: 1, params: &[P_QUERY] },
        "cost-summary" => &ArgSpec { required: 0, params: &[] },
        "memory-save" => &ArgSpec {
            required: 3,
            params: &[P_SCOPE, P_MEMID, P_MEMCONTENT],
        },
        "memory-read" | "memory-delete" => &ArgSpec {
            required: 2,
            params: &[P_SCOPE, P_MEMID],
        },
        "memory-list" => &ArgSpec { required: 0, params: &[P_SCOPE] },
        "memory-search" => &ArgSpec { required: 1, params: &[P_QUERY] },
        "subagent-spawn" => &ArgSpec {
            required: 1,
            params: &[&["goal", "task", "text", "input"]],
        },
        "subagent-status" => &ArgSpec { required: 1, params: &[P_ID] },
        "subagent-list" => &ArgSpec { required: 0, params: &[] },
        "glob-files" => &ArgSpec {
            required: 1,
            params: &[&["pattern", "glob", "path", "query"]],
        },
        "sleep" => &ArgSpec {
            required: 1,
            params: &[&["ms", "milliseconds", "duration"]],
        },
        "ask-user-question" => &ArgSpec {
            required: 1,
            params: &[&["question", "text", "prompt", "input"]],
        },
        "worktree-enter" | "worktree-exit" => &ArgSpec { required: 1, params: &[P_PATH] },
        "notebook-edit" => &ArgSpec {
            required: 0,
            params: &[&["input", "text", "path"]],
        },
        "lsp-hover" => &ArgSpec {
            required: 0,
            params: &[&["input", "symbol", "path"]],
        },
        // ── P1 additions ────────────────────────────────────────────────
        "read-file-lines" => &ArgSpec {
            required: 3,
            params: &[P_PATH, &["start", "from", "begin"], &["end", "to", "stop"]],
        },
        "multi-edit" => &ArgSpec {
            required: 2,
            params: &[P_PATH, &["edits", "changes", "ops", "input"]],
        },
        "get-errors" => &ArgSpec {
            required: 0,
            params: &[&["kind", "target", "tool", "input"]],
        },
        "git-commit" => &ArgSpec {
            required: 1,
            params: &[&["message", "msg", "text", "input"]],
        },
        "git-branch" => &ArgSpec {
            required: 0,
            params: &[&["action", "subcommand", "input"]],
        },
        "fetch-readable" => &ArgSpec {
            required: 1,
            params: &[&["url", "link", "href"]],
        },
        "html-to-markdown" => &ArgSpec {
            required: 1,
            params: &[&["html", "content", "text", "input"]],
        },
        "run-task" => &ArgSpec {
            required: 1,
            params: &[&["task", "preset", "name", "input"]],
        },
        _ => return None,
    })
}

/// Returns true if the given canonical tool name is in the runtime's
/// tool registry (i.e. has an argument schema). Exposed for tests and
/// for sanity checks by the embedded parser.
pub(crate) fn is_registered_tool(canonical: &str) -> bool {
    argspec_for(canonical).is_some()
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

    // Legacy aliases that diverge from the canonical descriptor name.
    let alias = match base.as_str() {
        "write-file" | "writefile" => Some("write-file"),
        "create-file" | "createfile" | "new-file" => Some("create-file"),
        "append-file" | "appendfile" => Some("append-file"),
        "read-file" | "readfile" | "cat-file" => Some("read-file"),
        "list-files" | "listdir" | "list-directory" | "ls" | "dir" => Some("list-files"),
        "move-file" | "movefile" | "rename-file" | "mv" => Some("move-file"),
        "delete-file" | "deletefile" | "remove-file" | "rm" => Some("delete-file"),
        "search-text" | "searchtext" | "search" | "grep" => Some("search-text"),
        "shell-command" | "shell" | "run-shell" | "run-command" | "exec" | "bash" | "sh" => {
            Some("shell-command")
        }
        "web-search" | "websearch" | "search-web" => Some("web-search"),
        "web-browse" | "browse" | "open-url" | "fetch" => Some("web-browse"),
        "http-get" | "get" => Some("http-get"),
        "http-post" | "post" => Some("http-post"),
        "glob-files" | "glob" => Some("glob-files"),
        "patch-file" | "patch" | "edit-file" => Some("patch-file"),
        "file-tree" | "tree" => Some("file-tree"),
        "read-context" | "context" => Some("read-context"),
        _ => None,
    };
    if let Some(name) = alias {
        return Some(name.to_string());
    }

    // P14: any tool registered in the runtime catalog is addressable by
    // its canonical name. This replaces the prior hand-maintained alias
    // table and lets the text parser dispatch the full 59-tool registry.
    if is_registered_tool(&base) {
        return Some(base);
    }
    None
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
    fn test_registry_driven_dispatch_covers_extended_tools() {
        // P14: any tool in the runtime catalog must now resolve through
        // the text parser. These are not in the legacy alias table but
        // should canonicalize + encode via `argspec_for`.
        for name in [
            "git-status",
            "git-diff",
            "git-log",
            "file-tree",
            "diagnostics",
            "todo-list",
            "team-list",
            "subagent-list",
            "cost-summary",
        ] {
            assert_eq!(
                canonicalize_embedded_tool_name(name),
                Some(name.to_string()),
                "canonicalize should accept registered tool `{name}`"
            );
            let call = EmbeddedToolCall {
                tool_name: name.into(),
                arguments: BTreeMap::new(),
            }
            .to_tool_call();
            assert!(call.is_some(), "zero-arg tool `{name}` must encode");
            assert_eq!(call.unwrap().input, "");
        }
    }

    #[test]
    fn test_registry_dispatch_encodes_multi_arg_tools() {
        // patch-file expects `old|new|path` (3 required slots).
        let mut args = BTreeMap::new();
        args.insert("old".into(), "hello".into());
        args.insert("new".into(), "world".into());
        args.insert("path".into(), "README.md".into());
        let call = EmbeddedToolCall { tool_name: "patch-file".into(), arguments: args }
            .to_tool_call()
            .expect("patch-file should encode");
        assert_eq!(call.input, "hello|world|README.md");

        // memory-save expects `scope|id|content`.
        let mut args = BTreeMap::new();
        args.insert("scope".into(), "project".into());
        args.insert("id".into(), "note-1".into());
        args.insert("content".into(), "remember this".into());
        let call = EmbeddedToolCall { tool_name: "memory-save".into(), arguments: args }
            .to_tool_call()
            .expect("memory-save should encode");
        assert_eq!(call.input, "project|note-1|remember this");
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

