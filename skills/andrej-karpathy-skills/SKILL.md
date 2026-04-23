---
name: andrej-karpathy-skills
description: Karpathy-style "think from first principles, verify with tiny scripts" research-engineer patterns. Reinforces the autoresearch + get-shit-down operating loops.
source: https://github.com/karpathy
integration: reference-only
status: descriptor-only
---

# andrej-karpathy-skills

Descriptor-only registration (P9 batch). The user reference was "anddrej-karpathy-skills" — normalized to `andrej-karpathy-skills`.

## Why registered
- Strong alignment with this repo's existing `skills/autoresearch` and `skills/get-shit-down` loops: form one falsifiable hypothesis, make the smallest reversible change, measure immediately.

## Integration plan
- No runtime code. This skill is consulted by the meta-loop when choosing **which** experiment to run next.

## Usage cue
When the agent is tempted to "add another abstraction layer" before measuring, stop and consult this skill. Prefer one more probe over one more refactor.
