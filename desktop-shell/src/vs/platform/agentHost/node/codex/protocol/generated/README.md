# Legacy Codex protocol types

These generated types are retained only for source compatibility with the disabled Codex adapter. The current OctoCode runtime uses the agent-host protocol under `src/vs/platform/agentHost/common/state/protocol/`, maintained by `scripts/sync-agent-host-protocol.ts`.

The old Codex generator, pinned `@openai/codex` development dependency, and CI freshness check were removed when OctoCode switched to its current runtime. Do not use the `Regenerate` comments in these legacy files as build instructions.
