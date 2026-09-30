use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct RuntimeCapability {
    pub name: &'static str,
    pub access: &'static str,
    pub surface: &'static str,
}

pub const RUNTIME_CAPABILITIES: &[RuntimeCapability] = &[
    capability("capabilities.list", "read", "runtime"),
    capability("ping", "read", "runtime"),
    capability("health", "read", "runtime"),
    capability("provider.resolve", "read", "runtime"),
    capability("agent.run", "execute", "internal"),
    capability("agent.cancel", "execute", "runtime"),
    capability("harness.prepare", "execute", "internal"),
    capability("harness.continue", "execute", "internal"),
    capability("harness.handoff", "execute", "internal"),
    capability("harness.transition", "write", "internal"),
    capability("worktree.status", "read", "runtime"),
    capability("worktree.list", "read", "runtime"),
    capability("worktree.branches", "read", "runtime"),
    capability("worktree.create", "write", "runtime"),
    capability("worktree.delete", "write", "runtime"),
    capability("worktree.checkout", "write", "runtime"),
    capability("supervisor.checkpoint", "write", "runtime"),
    capability("supervisor.resume", "read", "runtime"),
    capability("supervisor.delete", "write", "runtime"),
    capability("session.list", "read", "runtime"),
    capability("project.list", "read", "runtime"),
    capability("project.index", "read", "runtime"),
    capability("project.refresh", "write", "internal"),
    capability("project.create", "write", "runtime"),
    capability("project.assign", "write", "runtime"),
    capability("project.rename", "write", "runtime"),
    capability("project.delete", "write", "runtime"),
    capability("session.get", "read", "runtime"),
    capability("session.create", "write", "runtime"),
    capability("session.import_legacy", "write", "internal"),
    capability("session.update", "write", "runtime"),
    capability("session.delete", "write", "runtime"),
    capability("message.list", "read", "runtime"),
    capability("message.append", "write", "runtime"),
    capability("message.update", "write", "runtime"),
    capability("message.delete", "write", "runtime"),
    capability("event.list", "read", "runtime"),
    capability("event.page", "read", "runtime"),
    capability("event.history_start", "read", "runtime"),
    capability("event.append", "write", "runtime"),
    capability("log.list", "read", "runtime"),
    capability("log.create", "write", "runtime"),
    capability("log.delete", "write", "runtime"),
    capability("log.delete_matching", "write", "runtime"),
    capability("log.clear", "write", "runtime"),
    capability("log.purge", "write", "runtime"),
    capability("setting.get", "read", "runtime"),
    capability("setting.set", "write", "runtime"),
    capability("setting.delete", "write", "runtime"),
];

const fn capability(
    name: &'static str,
    access: &'static str,
    surface: &'static str,
) -> RuntimeCapability {
    RuntimeCapability {
        name,
        access,
        surface,
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Request {
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Response {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Event {
    pub sequence: u64,
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Default)]
pub struct EventSequencer(AtomicU64);

impl EventSequencer {
    pub fn next(&self, event: impl Into<String>, payload: Value) -> Event {
        Event {
            sequence: self.0.fetch_add(1, Ordering::Relaxed) + 1,
            event: event.into(),
            payload,
        }
    }
}

pub fn parse_request(line: &str) -> Result<Request, serde_json::Error> {
    serde_json::from_str(line)
}
