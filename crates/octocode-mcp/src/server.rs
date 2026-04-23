//! MCP server-side stdio loop.
//!
//! Exposes Octocode's internal tool catalog + executor as an MCP JSON-RPC server
//! over stdio. External MCP clients (VS Code MCP extension, Claude Desktop, etc.)
//! can discover and call Octocode tools through this transport.
//!
//! Protocol (line-delimited JSON-RPC 2.0):
//! - `initialize`       → `{ protocolVersion, serverInfo, capabilities: { tools: {} } }`
//! - `tools/list`       → `{ tools: [ { name, description, inputSchema } ] }`
//! - `tools/call`       → `{ content: [ { type: "text", text } ], isError }`
//! - `shutdown` / close → EOF / exits

use std::io::{BufRead, BufReader, Read, Write};

use octocode_core::{OctoError, PermissionMode, ToolCall, ToolCatalog, ToolExecutor};

pub struct McpServer<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub catalog: &'a dyn ToolCatalog,
    pub executor: &'a dyn ToolExecutor,
}

impl<'a> McpServer<'a> {
    pub fn new(
        name: &'a str,
        version: &'a str,
        catalog: &'a dyn ToolCatalog,
        executor: &'a dyn ToolExecutor,
    ) -> Self {
        Self {
            name,
            version,
            catalog,
            executor,
        }
    }

    /// Blocking loop: read newline-delimited JSON-RPC from `input`,
    /// write responses to `output`. Exits on EOF.
    pub fn serve<R: Read, W: Write>(&self, input: R, mut output: W) -> std::io::Result<()> {
        let reader = BufReader::new(input);
        for line in reader.lines() {
            let line = match line {
                Ok(v) => v,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let response = self.handle_line(trimmed);
            if let Some(resp) = response {
                writeln!(output, "{}", resp)?;
                output.flush()?;
            }
        }
        Ok(())
    }

    /// Convenience: serve on stdin/stdout.
    pub fn serve_stdio(&self) -> std::io::Result<()> {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        self.serve(stdin.lock(), stdout.lock())
    }

    fn handle_line(&self, line: &str) -> Option<String> {
        let req: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                return Some(error_response(
                    serde_json::Value::Null,
                    -32700,
                    &format!("parse error: {e}"),
                ))
            }
        };
        let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let method = match req.get("method").and_then(|v| v.as_str()) {
            Some(m) => m,
            None => {
                // Notifications without id still have method; a response without method is invalid.
                return Some(error_response(id, -32600, "missing method"));
            }
        };
        // Notifications (no id) do not get a response except for errors inside handle.
        let is_notification = req.get("id").is_none();

        match method {
            "initialize" => {
                let result = serde_json::json!({
                    "protocolVersion": "2024-11-05",
                    "serverInfo": { "name": self.name, "version": self.version },
                    "capabilities": { "tools": { "listChanged": false } },
                });
                Some(success_response(id, result))
            }
            "initialized" | "notifications/initialized" => {
                if is_notification {
                    None
                } else {
                    Some(success_response(id, serde_json::Value::Null))
                }
            }
            "tools/list" => {
                let tools: Vec<serde_json::Value> = self
                    .catalog
                    .descriptors()
                    .iter()
                    .map(|d| {
                        serde_json::json!({
                            "name": d.name,
                            "description": d.summary,
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "input": { "type": "string" }
                                },
                                "required": ["input"]
                            }
                        })
                    })
                    .collect();
                Some(success_response(id, serde_json::json!({ "tools": tools })))
            }
            "tools/call" => {
                let params = req.get("params").cloned().unwrap_or(serde_json::Value::Null);
                let name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    return Some(error_response(id, -32602, "missing tool name"));
                }
                let arg_input = params
                    .get("arguments")
                    .and_then(|a| a.get("input"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let perm = self
                    .catalog
                    .descriptor(&name)
                    .map(|d| d.minimum_permission.clone())
                    .unwrap_or(PermissionMode::ReadOnly);
                let call = ToolCall {
                    name: name.clone(),
                    input: arg_input,
                    permission: perm,
                };
                match self.executor.execute(call) {
                    Ok(result) => {
                        let payload = serde_json::json!({
                            "content": [
                                { "type": "text", "text": result.output }
                            ],
                            "isError": false
                        });
                        Some(success_response(id, payload))
                    }
                    Err(err) => {
                        let msg = match err {
                            OctoError::Tool(s)
                            | OctoError::Runtime(s)
                            | OctoError::Permission(s)
                            | OctoError::Provider(s)
                            | OctoError::Session(s)
                            | OctoError::Config(s) => s,
                        };
                        let payload = serde_json::json!({
                            "content": [ { "type": "text", "text": msg } ],
                            "isError": true
                        });
                        Some(success_response(id, payload))
                    }
                }
            }
            "shutdown" => Some(success_response(id, serde_json::Value::Null)),
            _ => {
                if is_notification {
                    None
                } else {
                    Some(error_response(id, -32601, &format!("method not found: {method}")))
                }
            }
        }
    }
}

fn success_response(id: serde_json::Value, result: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
    .to_string()
}

fn error_response(id: serde_json::Value, code: i64, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}
