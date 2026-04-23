---
name: pentagi
description: Autonomous penetration-testing AI agents. Registered as an external integration only; not activated by default. Useful reference for multi-step offensive workflows, sandboxing, and tool gating.
source: https://github.com/vxcontrol/pentagi
integration: external-agent
status: vendored-reference-offensive
vendored-at: third_party/pentagi
pinned-ref: main
fetch-requires: -AllowOffensive
---

# pentagi

Descriptor-only registration (P9 batch). The real project is a Go/TypeScript multi-agent pentest framework; integrating it requires explicit allowlist plus isolated network namespaces and is **gated** behind a future `skills-install --allow-network-offensive` flag.

## Why registered
- Good reference implementation for multi-agent task decomposition under a strict tool-permission model.
- OctoCode's `RuntimeToolExecutor` permission/circuit-breaker design overlaps in spirit.

## Integration plan (deferred)
1. Ship as MCP server adapter (`pentagi-mcp`) with its own approval gate.
2. Disabled by default; opt-in via workspace `.octocode/config.toml` key `integrations.pentagi.enabled = true`.
3. Never auto-triggered by general skill discovery.

## Safety notes
Offensive tooling. Do NOT auto-invoke. All tool calls must require human approval.
