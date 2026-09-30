---
name: ralph-wiggum
description: Continue a spec-driven task through fresh, bounded OctoCode iterations until its measurable acceptance criteria pass or a repeated blocker is proven.
license: MIT
metadata:
  origin: fstandhartinger/ralph-wiggum methodology
---

# Ralph Wiggum for OctoCode

Use OctoCode's current configured model and harness only. Do not invoke Claude, Codex, Copilot, Gemini, hosted gateways, or another agent CLI.

For each iteration:

1. Read the task spec, acceptance criteria, current plan, and retained local memory.
2. Select one unfinished criterion and execute the smallest useful change.
3. Run the criterion's real check and record the evidence in OctoCode logs.
4. Retain only durable progress and the next action before starting a fresh bounded iteration.
5. Finish only when every criterion is verified. Stop on repeated identical failure, unsafe expansion, or the configured iteration limit.

Never treat a model claim as test evidence and never weaken permissions, tests, or acceptance criteria to make the loop pass.
