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
