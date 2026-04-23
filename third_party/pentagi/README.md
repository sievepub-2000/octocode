---
upstream: https://github.com/vxcontrol/pentagi
pinned-ref: main
license: MIT
status: reference-only, offensive-tooling
---

# pentagi (vendored drop-point)

[PentAGI](https://github.com/vxcontrol/pentagi) is an autonomous
penetration-testing AI-agent framework. OctoCode **does not execute**
anything from this tree. The drop-point exists so the `pentagi` skill
descriptor ([../../skills/pentagi/SKILL.md](../../skills/pentagi/SKILL.md))
can point at a known-good commit for **code review** of multi-agent
decomposition patterns.

## Strict invariants

1. No file under `src/` is ever imported into a Cargo build.
2. No `pentagi` binary is ever invoked from any OctoCode code path.
3. The MCP adapter described in the skill descriptor must ship as a
   **separate crate** behind `integrations.pentagi.enabled = true` and
   go through the normal approval-token flow for every tool call.
4. The fetch script is interactive only — it prompts before cloning
   because this is offensive tooling.

## Why vendored at all

Having the source locally lets a reviewer verify the agent-decomposition
pattern claimed in the SKILL.md without requiring outbound network
access during security review.
