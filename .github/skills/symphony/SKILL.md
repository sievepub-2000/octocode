---
name: symphony
description: "Use when: coordinating Codex/Symphony style multi-agent software work, issue-to-PR workflows, review/merge state machines, or the openai/symphony repository."
---

# Symphony

Use the official OpenAI Symphony repository as workflow reference for agent coordination and issue/PR state transitions.

Local source cache:

- `C:/Users/周浩/.codex/vendor_imports/openai/symphony`

Operating pattern:

1. Treat work as a state machine: clarify issue, implement, validate, review, merge/land.
2. Keep PR/check/review status explicit before moving state.
3. Use this as a coordination model for pairing VS Code Copilot with local Codex.
4. Do not claim merge/readiness unless the relevant validation evidence exists.
