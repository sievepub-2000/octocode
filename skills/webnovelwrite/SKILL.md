---
name: webnovelwrite
description: Long-form narrative writing assistant patterns — chapter planning, continuity tracking, style lock-in. Useful when OctoCode is driven in "writing mode" rather than coding mode.
source: https://github.com/webnovelwrite
integration: reference-only
status: descriptor-only
---

# webnovelwrite

Descriptor-only registration (P9 batch).

## Why registered
- OctoCode is not a writing product, but users **do** feed it markdown / doc tasks. Having a dedicated writing-mode preset avoids regressing on prose quality when the coding-biased system prompts kick in.

## Integration plan (deferred)
- Add a preset: `octocode-cli chat --preset writing` that swaps the system prompt for prose-friendly guidance and disables code-specific tools.
