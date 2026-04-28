---
name: agent-browser
description: Agent-browser is an LLM-driven browser-automation framework (DOM querying, form filling, navigation) that complements lightpanda-headless-browser for heavier semantic interactions.
source: https://github.com/browser-use/browser-use
integration: external-browser
status: descriptor-only
---

# agent-browser

Descriptor-only registration (P12 batch). Companion to the existing [lightpanda-headless-browser](../lightpanda-headless-browser/SKILL.md) skill.

## Division of responsibility

| Concern | Tool | Scope |
| --- | --- | --- |
| Liveness / "is the page alive" | `lightpanda-headless-browser` | ultra-fast Zig/Rust binary, no JS eval heavy-lifting |
| Semantic navigation | `agent-browser` | LLM drives click/type/select with accessibility-tree awareness |
| Hard assertions | `playwright-webui-qa` (existing) | deterministic end-to-end verification |

OctoCode's `webui-e2e` CI job (added in P9) already uses Playwright; `agent-browser` is a candidate for **exploratory** flows where the tests are not pre-scripted but discovered by the agent.

## Integration plan (deferred to P13+)

1. Expose `agent_browser_visit(url, goal)` as a high-risk tool behind `RuntimeConfig.integrations.agent_browser.enabled`.
2. Enforce the same HTTPS allowlist as `skills-install` (see `crates/octocode-cli/src/skills_install.rs`), plus a page-size cap.
3. Page snapshots are written through `WorkspaceToolExecutor` (same path-traversal guardrails as file-writes).

## Safety notes

- **No auto-submission of forms that contain `password`, `card`, `ssn`** — reject at tool level.
- Every invocation must emit an `event_feed_json` entry for operator audit.
- Use `lightpanda-headless-browser` first as a liveness gate before spinning up an LLM-driven session, per verification instructions the workspace already follows (WebUI verification step).
