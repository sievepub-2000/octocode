# OctoCode Improvement Plan

> Based on cross-project analysis of Claude-code-1/3 and Clawcode

## Priority Tiers

### P0 — Critical Gaps (Must-Have)

#### 1. Multi-Agent Coordinator Mode
**Gap**: OctoCode is single-agent only; both Claude-code-3 and Clawcode have full coordinator modes.
**Plan**:
- Add `CoordinatorEngine` to `octocode-runtime`
- Support agent forking via `AgentTool` (spawn sub-agent with isolated context)
- Implement role-based execution: Architect → Executor → Reviewer
- Add `SendMessageTool` for inter-agent communication
- Add `TeamCreateTool` / `TeamDeleteTool` for managing agent teams
**Reference**: `claude-code-3/src/coordinator/coordinatorMode.ts`, `clawcode/src/coordinator.py`

#### 2. File Operation Guards
**Gap**: Only path-prefix check on `list-files`. No binary detection, size limits, or symlink escape prevention.
**Plan**:
- Add `FileGuard` module to `octocode-runtime`:
  - Binary detection (NUL-byte scan in first 8KB)
  - MAX_READ_SIZE (10MB) / MAX_WRITE_SIZE (5MB) enforcement
  - Symlink escape detection (resolve + check stays within workspace)
  - `.gitignore` respect for listing operations
**Reference**: Clawcode PARITY.md Lane 3

#### 3. Mock LLM Service for Testing
**Gap**: No deterministic testing of LLM interactions. Clawcode has `mock-anthropic-service` with 19 captured requests.
**Plan**:
- Create `crates/mock-provider` crate
- Capture and replay `/v1/chat/completions` requests
- Add parity harness with scripted scenarios:
  - streaming_text, tool_call_roundtrip, permission_prompt, multi_tool_turn
- Enable CI-friendly testing without real API keys
**Reference**: `clawcode/rust/crates/mock-anthropic-service`

---

### P1 — High Value (Should-Have)

#### 4. LSP Tool Integration
**Gap**: No language server protocol integration. Claude-code-3 has `LSPTool`.
**Plan**:
- Add `lsp-diagnostics` tool to runtime
- Connect to running LSP servers (rust-analyzer, pyright, tsserver)
- Expose: diagnostics, go-to-definition, find-references, rename
- Use `tower-lsp` or direct JSON-RPC over stdio
**Effort**: Medium — requires LSP client library

#### 5. Web Search Tool
**Gap**: No internet search capability. Claude-code-3 has `WebSearchTool`.
**Plan**:
- Add `web-search` tool using SearXNG or Brave Search API
- Support query + result count + domain filtering
- Return structured results (title, url, snippet)
**Effort**: Low — HTTP request + JSON parsing

#### 6. Task Lifecycle Expansion
**Gap**: Only `task-submit` and `task-list`. Claude-code-3 has Create/Get/List/Output/Stop.
**Plan**:
- Add `task-get`, `task-output`, `task-stop` tools
- Add background task execution with stdout/stderr capture
- Support timeout and cancellation
**Effort**: Medium — extend existing `TaskStore`

#### 7. Persistent Todo System
**Gap**: No persistent task tracking across sessions. Claude-code-3 has `TodoWriteTool`.
**Plan**:
- Add `todo-write` tool (create/update/complete items)
- Store in `.octocode/todos.json` per workspace
- Surface in session context automatically
**Effort**: Low

---

### P2 — Nice-to-Have (Enhancements)

#### 8. Session Branching
**Gap**: No conversation branching. Clawcode has branch-aware session recovery.
**Plan**:
- Extend `SessionSummary` with `parent_id` + `branch_name` (fields exist but unused)
- Add `session-branch` command to fork from any message
- Implement branch-tree visualization
**Effort**: Medium

#### 9. Voice Input Support
**Gap**: No voice interface. Clawcode has voice module.
**Plan**:
- Add `crates/octocode-voice` for speech-to-text
- Support Whisper API (local or remote)
- Integrate with REPL as alternative input
**Effort**: High

#### 10. Cost Tracking
**Gap**: No usage cost tracking. Claude-code-3 has cost-tracker.ts and costHook.ts.
**Plan**:
- Track input_tokens and output_tokens per provider per session
- Add pricing table for common models
- Expose via `session-cost` command and plugin hook
**Effort**: Low — token counts already in SessionSummary

#### 11. Additional Plugin Hooks
**Gap**: 5 hooks vs event-driven architecture in Clawcode (clawhip).
**Plan**:
- Add hooks: `BeforeCompaction`, `AfterCompaction`, `AgentSpawn`, `AgentComplete`, `ProviderFallback`
- Consider event bus pattern for decoupled plugin communication
**Effort**: Low

#### 12. Notebook Support
**Gap**: No Jupyter notebook editing. Claude-code-3 has `NotebookEditTool`.
**Plan**:
- Add `notebook-edit` tool (read/write cells, execute via Jupyter kernel)
- Support `.ipynb` file format
**Effort**: High

---

## Implementation Roadmap

```
Phase 1 (P0 — Weeks 1-4):
  ├── Multi-Agent Coordinator Mode
  ├── File Operation Guards
  └── Mock LLM Service

Phase 2 (P1 — Weeks 5-8):
  ├── LSP Tool Integration
  ├── Web Search Tool
  ├── Task Lifecycle Expansion
  └── Persistent Todo System

Phase 3 (P2 — Weeks 9-12):
  ├── Session Branching
  ├── Cost Tracking
  ├── Additional Plugin Hooks
  └── Voice Input (stretch)
```

## Current Strengths to Preserve

1. **Circuit-breaker provider routing** — unique among all projects; don't regress
2. **Compaction engine** — only project with automatic summarization + memory extraction
3. **Multi-surface UI** — CLI + Server + Desktop is a major differentiator
4. **Clean Rust architecture** — 8-crate layered design enables safe parallel development
5. **Plugin hook system** — well-designed, just needs more hook points
6. **Permission model** — simple but effective; extend rather than replace

## Metrics to Track

| Metric | Current | Phase 1 Target | Phase 2 Target |
|--------|---------|----------------|----------------|
| Tools | 34 | 36 | 42 |
| Tests | 89 | 120+ | 150+ |
| Clippy warnings | 0 | 0 | 0 |
| Agent modes | 1 (single) | 2 (+ coordinator) | 2 |
| E2E scenarios | 7 | 15+ | 20+ |
| Mock parity tests | 0 | 10+ | 15+ |
