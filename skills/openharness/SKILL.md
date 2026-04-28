---
name: openharness
description: Openharness is an open-source harness for structured LLM evaluation and capability benchmarking. Registered as an external reference to inform OctoCode's evaluation-gate design (see docs/eval/*) and the benchmark gate in runtime/src/benchmarks.rs.
source: https://github.com/openai/openharness
integration: external-benchmark
status: descriptor-only
---

# openharness

Descriptor-only registration (P12 batch). Openharness provides a reproducible harness for running LLM capability benchmarks across tasks and scoring them deterministically.

## Why registered

- OctoCode already ships a regression-gated benchmark (`check_regression` in `crates/octocode-runtime/src/benchmarks.rs`) with an absolute floor to tame sub-millisecond jitter; pairing with a capability harness closes the loop on "does the model still reason?" in addition to "is the runtime still fast?".
- Informs the design of a future `octocode-cli bench --harness openharness` subcommand.

## Integration plan (deferred to P13+)

1. Add an optional `integrations.openharness.task_dir` setting.
2. Provide a read-only adapter that streams `openharness` task outputs through the existing `event_feed_json` so WebUI can display runs.
3. Never auto-invoke; requires `OCTOCODE_ALLOW_BENCH=1`.

## Safety notes

Benchmarks may invoke external providers; treat quota and key exposure the same as any LLM call. Do not run against production providers from CI without explicit operator approval.
