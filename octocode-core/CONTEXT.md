# OctoCode domain language

- **Provider Kernel**: the Rust module that validates model configuration and maps supported vendor APIs to the protocol used by the Grok Harness.
- **Grok Harness**: the only model-facing reasoning, planning, tool-use, execution, verification, and recovery loop.
- **Runtime Host**: the Rust process that owns the Provider Kernel, agent processes, persistence, lifecycle status, and live events.
- **Workbench**: the VS Code-based desktop shell, editor, terminal, CLI, code intelligence, extension host, and React UI. It exposes development capabilities to the Grok Harness; it is not an Agent runtime or provider fallback.
- **Tool Bridge**: the MCP/ACP boundary through which the Grok Harness invokes Workbench-only capabilities.
- **Knowledge Worker**: the isolated Scrapling-based MCP process for webpage acquisition and Markdown export. The Runtime Host database remains authoritative.
