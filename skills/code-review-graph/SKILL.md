---
name: code-review-graph
description: Graph-based code-review assistant. Builds a call/dependency graph of a diff and surfaces reviewer-relevant hotspots. Registered for future integration into OctoCode's review workflow.
source: https://github.com/code-review-graph
integration: external-library
status: descriptor-only
---

# code-review-graph

Descriptor-only registration (P9 batch).

## Why registered
- Complements OctoCode's existing PR review flow with graph-aware context (imports, call edges, type refs).
- Aligns with P9-A's local token index — a follow-up can layer graph edges on top of the same file enumeration.

## Integration plan (deferred)
1. Consume as a Rust crate if upstream offers one; otherwise wrap as a CLI subprocess.
2. Add `octocode-cli review-graph <base>..<head>` to emit JSON hotspots.
3. Feed hotspots into the WebUI review panel as annotations.

## Inputs / Outputs (contract)
- Input: two git refs.
- Output: JSON `{nodes:[...], edges:[...], hotspots:[{path, reason, score}]}`.
