---
name: tools-hub
description: Single source of truth that lists every tool, MCP server, skill, and hook known to this OctoCode install, and stays in sync with octocode-runtime's tool catalog.
integration: internal
---

# tools-hub

`tools-hub` is the **registry view** over four separate subsystems:

| Surface   | Authoritative source                                    |
|-----------|---------------------------------------------------------|
| Tools     | `octocode-runtime` `RuntimeToolCatalog::descriptors()`  |
| Commands  | `octocode-commands` slash registry                      |
| Skills    | `octocode-skills` `SkillRegistry::discover(...)`        |
| MCP       | Client config merged from `mcp-config --install` hosts  |
| Hooks     | Workspace `.octocode/hooks/*` + user config hooks       |

## Invariants

- Whenever `octocode-runtime` adds or removes a tool descriptor, `tools-hub list tools --json` MUST reflect the change on the **next CLI run** (no daemon restart, no cache rebuild).
- Whenever a SKILL.md is created or deleted, `tools-hub list skills --json` MUST reflect the change on the next CLI run.
- The hub **never persists a cached copy** that could drift from the authoritative source. It is a thin view layer.

## Surface

The CLI exposes:

- `octocode-cli tools-list` (existing) — runtime tool descriptors.
- `octocode-cli commands-list` (existing) — slash commands.
- `octocode-cli skills-list` (existing) — skills.
- `octocode-cli providers-list` / `providers-health` (existing) — providers.
- `octocode-cli doctor` (existing) — aggregated snapshot.

These are **already** the tools-hub. This SKILL.md documents the invariant so downstream automation (Claude Desktop, Cursor, VS Code extensions, CI) can rely on the contract.

## Adding a new tool

1. Register descriptor in `crates/octocode-runtime/src/tools.rs::descriptors()`.
2. Update `tool_catalog_has_expected_tools` count assertion.
3. `cargo test -p octocode-runtime` — guardrail enforces parity.
4. No tools-hub edit required — it re-reads on each invocation.

## Removing a tool

Same flow in reverse. The hub picks up the removal automatically.
