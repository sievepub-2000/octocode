---
name: gitnexus
description: GitNexus is a zero-server, client-side code intelligence engine that builds a knowledge graph of a repository directly in the browser. Registered as an external reference to inform OctoCode's code-intel and graph-aware tool design.
source: https://github.com/abhigyanpatwari/GitNexus
integration: external-code-intel
status: descriptor-only
---

# gitnexus

Descriptor-only registration. Companion reference for OctoCode's future
graph-aware code intelligence layer.

## Why registered

GitNexus demonstrates a **zero-server** code knowledge-graph approach
(repo → AST → symbols → cross-references) that runs entirely in the
browser. OctoCode's runtime currently exposes file-level navigation
(`read-file`, `glob-files`, `search-text`, `lsp-hover`) but no symbol
graph; GitNexus is the canonical reference design when we evaluate a
future `code-graph` tool family.

## Integration plan (deferred)

1. Optional setting `integrations.gitnexus.enabled` (default off).
2. A new tool `code-graph-query <symbol>` that returns nearest-symbol
   neighbours from a locally generated graph stored under
   `.octocode/graph.json` (no remote calls).
3. The graph builder runs as a subagent task, gated by `enforce_approval`.

## Safety notes

- Never submit repository content to a hosted graph service.
- Reuse `runtime/file_guard.rs` for binary / size / symlink safety when
  walking the workspace.
- Treat AST/parser inputs as untrusted; fail closed on parse errors.
