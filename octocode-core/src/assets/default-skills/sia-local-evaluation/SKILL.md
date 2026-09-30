---
name: sia-local-evaluation
description: Run SIA-style iterative evaluation and feedback using OctoCode's configured local model; use for measurable self-improvement without hosted evaluators.
---

# Local SIA evaluation

Use the open-source SIA evaluation-loop methodology locally. Do not select Claude, OpenHands, hosted evaluators, API-key providers, or SIA's web service.

For an improvement task:

1. Define one measurable acceptance test and an iteration limit.
2. Run the current OctoCode implementation against the test.
3. Feed the observable failure back through the configured OctoCode local model.
4. Apply the smallest supported correction and rerun the same test.
5. Stop on success, repeated identical failure, or the iteration limit; retain the evidence in normal OctoCode logs.

Do not mutate production data or expand permissions as part of an evaluation loop.
