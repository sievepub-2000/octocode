//! Subagent JSON-line RPC framing.
//!
//! Provides a minimal, dependency-free wire protocol for talking to a
//! sub-agent that runs in a separate process. The protocol is one
//! JSON object per line, framed by `\n`. We deliberately do not pull
//! `serde_json` into this crate's runtime path: the agent loop uses
//! the same hand-rolled string framing as the gateway/webhook layer,
//! and the sub-agent process is responsible for re-serialising on its
//! side.
//!
//! Wire format
//! -----------
//! Request (driver -> subagent):
//!     {"id":"<correlation-id>","op":"run","goal":"<text>","timeout_secs":N}
//! Response (subagent -> driver):
//!     {"id":"<correlation-id>","ok":true,"result":"<text>"}
//!     {"id":"<correlation-id>","ok":false,"error":"<text>"}
//!
//! Strings inside the payload are escaped with the same rules as
//! `octocode-gateway::escape_json` (double-quote, backslash, newline).
//!
//! This module is **process-isolation-ready** but does not itself
//! spawn a subprocess: the runtime owns lifecycle, this module owns
//! framing only. Spawning is intentionally deferred to the host so
//! Windows-specific quoting differences can be validated end-to-end
//! before the executor switches to subprocess mode by default.
#![allow(dead_code)]
use octocode_core::OctoError;

/// Outbound request payload. `id` is an opaque correlation token that
/// is echoed back in the response — callers may reuse `SubAgentTask::id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcRequest {
    pub id: String,
    pub goal: String,
    pub timeout_secs: u64,
}

/// Inbound response payload. Exactly one of `result` / `error` is set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcResponse {
    pub id: String,
    pub ok: bool,
    pub result: String,
    pub error: String,
}

/// Encode a request as a single JSON line (no trailing newline). The
/// caller appends `\n` when writing to the subprocess stdin.
pub fn encode_request(req: &RpcRequest) -> String {
    format!(
        "{{\"id\":\"{}\",\"op\":\"run\",\"goal\":\"{}\",\"timeout_secs\":{}}}",
        escape(&req.id),
        escape(&req.goal),
        req.timeout_secs
    )
}

/// Encode a response. Convenience for the subagent half.
pub fn encode_response(resp: &RpcResponse) -> String {
    if resp.ok {
        format!(
            "{{\"id\":\"{}\",\"ok\":true,\"result\":\"{}\"}}",
            escape(&resp.id),
            escape(&resp.result)
        )
    } else {
        format!(
            "{{\"id\":\"{}\",\"ok\":false,\"error\":\"{}\"}}",
            escape(&resp.id),
            escape(&resp.error)
        )
    }
}

/// Decode a single response line. Returns an error if any required
/// field is missing or the `ok` flag cannot be parsed.
pub fn decode_response(line: &str) -> Result<RpcResponse, OctoError> {
    let id = extract_string(line, "id")
        .ok_or_else(|| OctoError::Runtime(String::from("subagent rpc response missing 'id'")))?;
    let ok_raw = extract_bare(line, "ok").ok_or_else(|| {
        OctoError::Runtime(String::from("subagent rpc response missing 'ok'"))
    })?;
    let ok = match ok_raw.as_str() {
        "true" => true,
        "false" => false,
        other => {
            return Err(OctoError::Runtime(format!(
                "subagent rpc response 'ok' must be true|false, got {other}"
            )))
        }
    };
    let result = extract_string(line, "result").unwrap_or_default();
    let error = extract_string(line, "error").unwrap_or_default();
    Ok(RpcResponse {
        id,
        ok,
        result,
        error,
    })
}

/// Decode an inbound request line (used by the subagent half during
/// tests and by future in-tree validators).
pub fn decode_request(line: &str) -> Result<RpcRequest, OctoError> {
    let id = extract_string(line, "id")
        .ok_or_else(|| OctoError::Runtime(String::from("subagent rpc request missing 'id'")))?;
    let goal = extract_string(line, "goal").unwrap_or_default();
    let timeout_secs = extract_bare(line, "timeout_secs")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    Ok(RpcRequest {
        id,
        goal,
        timeout_secs,
    })
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn extract_string(body: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let idx = body.find(&needle)?;
    let rest = &body[idx + needle.len()..];
    let after_colon = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
    let stripped = after_colon.strip_prefix('"')?;
    let mut out = String::with_capacity(stripped.len());
    let mut chars = stripped.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                other => out.push(other),
            },
            c => out.push(c),
        }
    }
    None
}

fn extract_bare(body: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let idx = body.find(&needle)?;
    let rest = &body[idx + needle.len()..];
    let after_colon = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
    if after_colon.starts_with('"') {
        return None;
    }
    let end = after_colon
        .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .unwrap_or(after_colon.len());
    let v = after_colon[..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_request() {
        let req = RpcRequest {
            id: String::from("task-1"),
            goal: String::from("ship slice"),
            timeout_secs: 60,
        };
        let line = encode_request(&req);
        assert!(line.contains("\"op\":\"run\""));
        let decoded = decode_request(&line).unwrap();
        assert_eq!(decoded, req);
    }

    #[test]
    fn round_trip_success_response() {
        let resp = RpcResponse {
            id: String::from("task-1"),
            ok: true,
            result: String::from("done"),
            error: String::new(),
        };
        let line = encode_response(&resp);
        let decoded = decode_response(&line).unwrap();
        assert_eq!(decoded, resp);
    }

    #[test]
    fn round_trip_failure_response_carries_error_text() {
        let resp = RpcResponse {
            id: String::from("task-2"),
            ok: false,
            result: String::new(),
            error: String::from("permission denied: \"workspace\""),
        };
        let line = encode_response(&resp);
        assert!(line.contains("\"ok\":false"));
        let decoded = decode_response(&line).unwrap();
        assert_eq!(decoded.error, "permission denied: \"workspace\"");
        assert!(!decoded.ok);
    }

    #[test]
    fn decoding_rejects_missing_fields() {
        let err = decode_response("{\"ok\":true}").unwrap_err();
        assert!(err.to_string().contains("missing 'id'"));
        let err = decode_response("{\"id\":\"x\"}").unwrap_err();
        assert!(err.to_string().contains("missing 'ok'"));
    }

    #[test]
    fn embedded_quotes_and_newlines_survive_round_trip() {
        let resp = RpcResponse {
            id: String::from("task-3"),
            ok: true,
            result: String::from("line1\nline2 \"quoted\"\tend"),
            error: String::new(),
        };
        let line = encode_response(&resp);
        assert!(!line.contains('\n'), "encoded line must be single-line");
        let decoded = decode_response(&line).unwrap();
        assert_eq!(decoded.result, "line1\nline2 \"quoted\"\tend");
    }
}
