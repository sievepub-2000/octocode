---
name: get-shit-down
description: Octocode execution skill for narrow boundary changes, immediate checks, and practical delivery.
---

# get-shit-down

Keep Octocode moving with short, validated steps.

## When to use

- The change touches a known boundary and should not expand into a rewrite.
- You need to keep Windows and runtime validation active.
- You are debugging CLI or UI-shell regressions.

## Instructions

1. Start from the owning boundary, not the outer wiring.
2. Form one local hypothesis.
3. Make the smallest edit that can prove or implement it.
4. Run the cheapest focused check immediately.
5. If the result is ambiguous, read one neighboring call site or test and decide.
6. Stop widening scope when the requested slice is validated.