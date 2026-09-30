# ADR-0001: One Rust Provider Kernel

## Status

Accepted

## Decision

All model configuration crosses the Runtime Host `provider.resolve` interface. The Provider Kernel owns validation, protocol selection, and limits. Grok Build is the sole Agent Harness and therefore the sole owner of reasoning, planning, tool use, execution, verification, and recovery.

The VS Code Workbench remains the desktop shell, editor, terminal, CLI, code-intelligence and extension substrate. It exposes those capabilities through the Tool Bridge but cannot run a parallel Agent loop or receive provider fallback traffic. Persistence, lifecycle status, and live execution events stay in the Runtime Host.

## Consequences

- Responses, Chat Completions/tool calls, and Anthropic Messages have one provider implementation and one test surface. Unsupported providers and protocols fail explicitly instead of silently entering the old VS Code Agent.
- Grok Build's mature harness and VS Code's mature development substrate remain reusable without duplicating their responsibilities.
- UI, VS Code internals, Office parsers, and Scrapling remain in their native mature runtimes.
