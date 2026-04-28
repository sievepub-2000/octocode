---
name: browser-harness
description: Browser Harness is a self-healing browser-automation harness from browser-use that lets LLMs complete arbitrary web tasks. Registered as an external reference for OctoCode's exploratory web-automation pathway.
source: https://github.com/browser-use/browser-harness
integration: external-browser
status: descriptor-only
---

# browser-harness

Descriptor-only registration. Sits next to the existing
[agent-browser](../agent-browser/SKILL.md),
[browser-use](../browser-use/SKILL.md),
[lightpanda-headless-browser](../lightpanda-headless-browser/SKILL.md), and
[playwright-webui-qa](../playwright-webui-qa/SKILL.md) skills.

## Division of responsibility

| Concern                | Tool                          | Scope |
| ---                    | ---                           | --- |
| Liveness probe         | `lightpanda-headless-browser` | ultra-fast Zig/Rust binary |
| Self-healing flows     | `browser-harness`             | LLM retries on selector/UI drift |
| Exploratory navigation | `agent-browser`               | LLM-driven semantic navigation |
| Hard assertions        | `playwright-webui-qa`         | deterministic E2E |

## Integration plan (deferred to a later iteration)

1. Add `integrations.browser_harness.enabled` (default off).
2. Expose `browser-harness-run <goal>` tool routed through
   `WorkspaceToolExecutor`, gated by `enforce_approval`.
3. Reuse the `skills-install` HTTPS allowlist (see
   `crates/octocode-cli/src/skills_install.rs`) plus a strict page-size
   cap before any model context is hydrated.
4. Emit one `event_feed_json` entry per step for operator audit.

## Safety notes

- Refuse forms whose fields contain `password`, `card`, `ssn`, or `otp`.
- Snapshots and downloads must traverse `runtime/file_guard.rs`.
- Treat LLM-suggested URLs as untrusted; deny RFC1918 and metadata IPs.
