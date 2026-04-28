---
name: bytebot
description: Bytebot is an open-source desktop-agent framework exposing OS-level primitives (keyboard, mouse, shell, file I/O) to LLM agents. Registered as reference for uplifting OctoCode's agent tool-calling surface.
source: https://github.com/bytebot-ai/bytebot
integration: external-agent
status: descriptor-only
---

# bytebot

Descriptor-only registration (P12 batch). Bytebot targets general computer-use agents; its tool schema is useful reference for OctoCode's own `RuntimeToolCatalog`.

## Why registered

OctoCode currently exposes file I/O, shell, and web tools via `octocode_runtime::WorkspaceToolExecutor` behind `PermissionMode` gating. Bytebot's catalog shape (keyboard/mouse + OS primitives) inspires a future **desktop-control** capability tier, gated strictly.

## Capability uplift targets

| OctoCode tool | Bytebot parallel | Uplift |
| --- | --- | --- |
| `shell-command` | `run_command` | add structured stdout/stderr framing and timeout in `ToolExecutor` return type |
| `read-file` / `write-file` | `read_file` / `write_file` | shared; already covered |
| (none) | `screenshot` | candidate new tool, desktop-only, approval-gated |
| (none) | `keyboard_type` / `mouse_click` | candidate new tools, `Permission::HighRisk` |

## Integration plan (deferred to P13+)

1. Define `DesktopTool` trait alongside existing `ToolExecutor`.
2. Gate every desktop-control tool behind `RuntimeConfig.integrations.bytebot.enabled` **and** interactive approval (never automatic).
3. Desktop tools MUST be absent from the default MCP catalog emitted by `mcp-serve`.

## Safety notes

Desktop control is high-risk. Never enable in a container that also has browser or file-system access without an operator-visible approval-token flow equivalent to the current `shell-command` path.
