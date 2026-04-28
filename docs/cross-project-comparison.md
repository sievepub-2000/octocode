# Cross-Project Comparison Report

> OctoCode vs Claude-code-1 vs Claude-code-3 vs Clawcode

## Projects Analyzed

| Project | Language | Location | Core Focus |
|---------|----------|----------|------------|
| **OctoCode** | Rust (8 crates) | `octocode/` | Production CLI/Desktop agent |
| **Claude-code-1** | TypeScript | `github/claude-code-1/` | Official plugin reference |
| **Claude-code-3** | TypeScript | `github/claude-code-3/` | Full reverse-engineered app |
| **Clawcode** | Python + Rust | `github/clawcode/` | Multi-agent orchestration |

---

## A. Architecture

### OctoCode — Layered Modular Rust
- 8 crates: core, api, runtime, cli, mcp, plugins, skills, commands
- Entry points: CLI (`chat`), Server (`serve`), Desktop (`desktop` via tao/wry)
- Clean dependency graph: core → api → runtime → cli

### Claude-code-1 — Plugin Ecosystem
- 16+ official plugins (code-review, commit-commands, security-guidance, etc.)
- NPM package `@anthropic-ai/claude-code`

### Claude-code-3 — Monolithic TypeScript
- React/Ink terminal UI, coordinator mode, 41+ tools
- Modules: assistant, coordinator, tools, services/mcp, skills, commands, context, state, memdir

### Clawcode — Multi-Agent Orchestration
- Python reference + Rust canonical (9 crates, 48K LOC, 292 commits)
- OmX (workflow), clawhip (event routing), OmO (conflict resolution)
- Discord-first UX, 9-lane parallel execution

---

## B. Tools

| Project | Count | Highlight |
|---------|-------|-----------|
| **OctoCode** | 34 | Permission-layered (5 iterations), vector-search/upsert |
| **Claude-code-3** | 41+ | AgentTool, TeamCreate/Delete, LSPTool, ScheduleCron, WebSearch |
| **Clawcode** | Ported snapshot | Loaded from JSON, MCP-aware, permission-context filtering |

### Gap Analysis for OctoCode
Missing tools compared to Claude-code-3:
- **AgentTool** — spawn sub-agents
- **LSPTool** — language server integration
- **WebSearchTool** — internet search
- **TodoWriteTool** — persistent task tracking
- **NotebookEditTool** — Jupyter support
- **TaskCreate/Get/List/Output/Stop** — full task lifecycle
- **TeamCreate/Delete** — multi-agent teams

---

## C. Memory & Session Management

| Feature | OctoCode | Claude-code-3 | Clawcode |
|---------|----------|---------------|----------|
| Session Store | File + Memory | Session history | Transcript + task log |
| Compaction | ✅ 100K threshold, preserve recent 6 | Cost tracking | Transcript logging |
| Long-term Memory | extract_memories() | memdir module | Not explicit |
| Away Summary | ✅ away_summary() | Session history | Branch-aware |
| Token Estimation | ~4 chars/token | Token counting | Variable |

**OctoCode Advantage**: Has both automatic compaction engine AND memory extraction. Other projects lack this combined capability.

---

## D. Multi-Agent Support

| Feature | OctoCode | Claude-code-3 | Clawcode |
|---------|----------|---------------|----------|
| Sub-agent Spawn | agent-action (minimal) | AgentTool (full) | Core design |
| Coordinator Mode | ❌ | ✅ coordinatorMode.ts | ✅ coordinator.py |
| Team Management | ❌ | TeamCreate/Delete | OmX/OmO/clawhip |
| Parallel Execution | ❌ | ✅ | 9-lane parallel |
| Role-based Agents | ❌ | Architect/Executor/Reviewer | Same |

**OctoCode Gap**: This is the largest missing capability. Need coordinator mode + agent forking.

---

## E. Policy & Permissions

| Feature | OctoCode | Claude-code-3 | Clawcode |
|---------|----------|---------------|----------|
| Permission Levels | ReadOnly / WorkspaceWrite / DangerFullAccess | LSP-aware | Granular context |
| Sandbox | Permission modes only | Tool filtering | unshare probing + container |
| File Guards | Path security on list-files | ✅ | Binary detection, size limits, symlink escape |
| CLI Flags | `--permission-mode` | ✅ | ✅ |

**OctoCode Gap**: Need file operation guards (binary detection, size limits, symlink escape).

---

## F. Hooks & Plugins

| Feature | OctoCode | Claude-code-3 | Clawcode |
|---------|----------|---------------|----------|
| Hook Types | 5 (SessionStart, Before/AfterPrompt, Before/AfterTool) | Tool ecosystem | Event-driven (clawhip) |
| Plugin Trait | ✅ RuntimePlugin | Plugin dirs (16+) | First-class |
| Audit Log | ✅ PluginAuditEvent | ✅ | ✅ |
| Discovery | ✅ discovery.rs | NPM | ✅ |

**OctoCode Strength**: Hook system is well-designed. Could add more hook points (BeforeCompaction, AfterAgentSpawn).

---

## G. Provider Routing

| Feature | OctoCode | Claude-code-3 | Clawcode |
|---------|----------|---------------|----------|
| Provider Count | 8 kinds | Multi-provider | Bearer + proxy |
| Circuit Breaker | ✅ (2 failures, 30s cooldown) | ❌ | ❌ |
| Health Cache | ✅ 5s TTL | ❌ | ❌ |
| Model Aliases | opus/sonnet/haiku | ✅ | opus/sonnet/haiku |
| Streaming | ✅ SSE | ✅ | ✅ |

**OctoCode Advantage**: Circuit-breaker provider routing is unique among all four projects.

---

## H. UI

| Surface | OctoCode | Claude-code-3 | Clawcode |
|---------|----------|---------------|----------|
| CLI/REPL | ✅ | ✅ (Ink) | ✅ (rustyline) |
| Server/WebUI | ✅ | ❌ | ❌ |
| Desktop App | ✅ (tao/wry) | ❌ | ❌ |
| Voice | ❌ | ❌ | ✅ |

**OctoCode Advantage**: Only project with native desktop app AND web server.

---

## I. Testing

| Metric | OctoCode | Claude-code-3 | Clawcode |
|--------|----------|---------------|----------|
| Total Tests | 89 | Not visible | Parity harness |
| Unit Tests | ✅ per-crate | Implicit | ✅ |
| E2E Tests | 7 (feature-gated) | Implicit | 10 scripted scenarios |
| Mock Service | ❌ | ❌ | ✅ mock-anthropic-service |
| Parity Diff | ❌ | ❌ | ✅ run_mock_parity_diff.py |

**OctoCode Gap**: Need mock LLM service for deterministic testing.

---

## Decision Matrix

| Dimension | OctoCode | Claude-code-1 | Claude-code-3 | Clawcode | Best |
|-----------|----------|---------------|---------------|----------|------|
| Architecture | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | OctoCode/Clawcode |
| Tools | ⭐⭐⭐ | ⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Claude-code-3 |
| Memory | ⭐⭐⭐⭐ | ⭐ | ⭐⭐⭐ | ⭐⭐ | OctoCode |
| Multi-Agent | ⭐ | ⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Clawcode |
| Permissions | ⭐⭐⭐ | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | Clawcode |
| Plugins | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | Tied |
| Provider Routing | ⭐⭐⭐⭐⭐ | ⭐ | ⭐⭐ | ⭐⭐ | OctoCode |
| UI | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ | OctoCode |
| Testing | ⭐⭐⭐ | ⭐ | ⭐ | ⭐⭐⭐⭐ | Clawcode |

### Verdict
- **OctoCode** excels in: provider routing, UI surfaces, memory/compaction, architecture
- **OctoCode** lags in: multi-agent, tool count, testing infrastructure
- **Priority focus**: multi-agent coordination, file guards, mock testing
