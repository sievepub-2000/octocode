# OctoCode

OctoCode is a local-first desktop agent built around one execution chain:

1. the Rust runtime owns provider normalization, persistence, lifecycle, and policy;
2. Grok is the sole reasoning, planning, and autonomous execution harness;
3. the VS Code workbench supplies editing, terminal, diagnostics, symbols, code intelligence, and extension compatibility through a narrow authenticated MCP bridge.

The desktop UI provides conversation and task management, live execution status, an integrated terminal, multimodal artifact viewing, local knowledge capture, and 17 selectable interface languages. Sign-in is optional and disabled by the build-time product setting unless a commercial distribution enables it.

## Local model

The default private deployment uses the OpenAI-compatible Chat Completions/tool-calls protocol. Responses API remains available for upstreams that emit a protocol-compliant Responses stream. Provider credentials are passed to the child process environment and are not written to the generated Grok configuration.

## Runtime data

Operational records are stored in one SQLite database with WAL, FTS5, and vector search. The optional crawler runs in one product-managed Python environment and writes knowledge through the Rust-owned store.

### Runtime event reads: compatibility change (2026-10-02)

The stdio JSON-RPC `event.list` method still returns an array on success. Its actual selected result is now limited to 2000 rows and 8 MiB of UTF-8 bytes summed across each selected kind and projected JSON payload. Omitted/null limits and large explicit limits remain valid when the selected result fits; smaller explicit limits retain their requested range. The exclusive `after` cursor and `presentation` projection retain their existing semantics. Row/byte preflight and payload reads share one read snapshot; exceeding either budget returns code `-32005` with `event.list resource limit exceeded; use event.page with presentation=false`, never a partial array or an empty-success fallback.

This intentionally changes formerly successful oversized reads, including external MCP and script clients. Callers needing complete raw history must use `event.page` with `presentation=false` and follow `next` while `has_more` is true; they must propagate errors rather than treat them as proof that events are absent. The protocol version remains 1 and access permissions are unchanged. `event.page` and the internal Store `events`/`event_page` contracts are unchanged: a page can still contain a single very large payload, so paging alone is not a universal memory bound. The 8 MiB list budget measures stored kind plus projected payload bytes, not JSON response framing or total process memory.
