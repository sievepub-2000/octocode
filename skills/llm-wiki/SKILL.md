---
name: llm-wiki
description: LLM-wiki is a curated, living knowledge base about LLM systems programming, prompt engineering, and long-term memory strategies. Registered as a reference skill to lift OctoCode's systems-programming and memory design.
source: https://github.com/rasbt/LLMs-from-scratch
integration: external-knowledge
status: descriptor-only
---

# llm-wiki

Descriptor-only registration (P12 batch). Used as a reference body of knowledge for:

- **Systems programming uplift** — tokenization, attention, KV-cache, batching, quantization, and how each interacts with coordinator latency budgets.
- **Memory uplift** — session store layering (OctoCode's `FileSessionStore` + SQLite persistence), context-window budgeting, and semantic vs. episodic memory separation.

## Why registered

OctoCode's runtime already separates `SessionStore`, `ConversationStore`, and `TurnStateStore`; the llm-wiki material is a rigorous reference for extending those stores with:

1. **Episodic memory** — per-session event journal (already partially present via `event_feed_json`).
2. **Semantic memory** — embeddings-backed retrieval layered above the P9 token index (`crates/octocode-cli/src/index.rs`).
3. **Procedural memory** — skill index itself (this directory).

## Integration plan (deferred to P13+)

1. Add a `crates/octocode-runtime/src/memory.rs` module that unifies the three stores behind a `MemoryLayer` trait.
2. Expose `octocode-cli memory-stats` subcommand emitting counts and byte sizes per layer.
3. Wire semantic retrieval through a pluggable embedding provider (reuses `ProviderFactory`).

## Safety notes

Embedding calls are outbound network traffic — gate by the same allowlist governance as `skills-install`.
