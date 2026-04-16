# Clawcode 到 Octocode 模块迁移映射

## 目标

本文件用于把当前 clawcode 的实现面映射到 octocode 的目标模块，保证重构时：

1. 不漏功能。
2. 不重复建轮子。
3. 不把 CLI、runtime、provider、UI、integration 混杂回去。

## 1. 源仓库主要 Rust crate

### `api`

原职责：

1. provider client
2. streaming / SSE
3. request sizing
4. auth 与 base URL

目标落点：

1. `octocode-api`
2. 其中公共 provider descriptor / capability 进入 `octocode-core`

### `runtime`

原职责：

1. conversation runtime
2. session persistence
3. permissions
4. config
5. file ops
6. bash / sandbox
7. hooks / plugin lifecycle
8. MCP lifecycle
9. branch / lane / policy / recovery

目标落点：

1. 当前先进入 `octocode-runtime`
2. 后续继续拆分为：
   - runtime-session
   - runtime-policy
   - runtime-mcp
   - runtime-platform
   - runtime-workflow

### `commands`

原职责：

1. slash command spec
2. command parsing
3. help 与 JSON/text renderer

目标落点：

1. 短期留在 `octocode-cli`
2. 后续抽出 `octocode-commands`

### `tools`

原职责：

1. built-in tools
2. tool dispatch
3. agent / todo / notebook / web / search 等工具实现

目标落点：

1. tool contract 进入 `octocode-core`
2. tool registry 与执行器进入 `octocode-runtime`
3. 具体工具逐步迁入 runtime 下的子模块

### `plugins`

原职责：

1. plugin metadata
2. install / enable / disable / update
3. hook integration

目标落点：

1. 短期由 `octocode-runtime` 承接 lifecycle
2. 后续独立为 `octocode-plugins`

### `compat-harness`

原职责：

1. 对上游 manifest 做抽取与 parity 校验

目标落点：

1. 后续独立为 `octocode-compat`

### `rusty-claude-cli`

原职责：

1. 主 CLI
2. REPL
3. streaming render
4. arg parsing
5. 本地命令入口

目标落点：

1. `octocode-cli`

## 2. 当前 clawcode runtime 关键模块映射

### 平台与执行基础

1. `bash.rs` -> `octocode-runtime::platform`
2. `file_ops.rs` -> `octocode-runtime::workspace`
3. `sandbox.rs` -> `octocode-runtime::permission`
4. `config.rs` -> `octocode-runtime::config`

### 会话与对话

1. `conversation.rs` -> `octocode-runtime::conversation`
2. `session.rs` -> `octocode-runtime::session`
3. `session_control.rs` -> `octocode-runtime::session`
4. `compact.rs` -> `octocode-runtime::conversation::compaction`

### 权限与策略

1. `permissions.rs` -> `octocode-runtime::permission`
2. `permission_enforcer.rs` -> `octocode-runtime::permission`
3. `policy_engine.rs` -> `octocode-runtime::workflow`
4. `recovery_recipes.rs` -> `octocode-runtime::workflow`

### MCP / hooks / plugins

1. `mcp*.rs` -> `octocode-runtime::mcp`
2. `hooks.rs` -> `octocode-runtime::hooks`
3. `plugin_lifecycle.rs` -> `octocode-runtime::plugins`

### lane / branch / worker

1. `lane_events.rs` -> `octocode-runtime::workflow`
2. `worker_boot.rs` -> `octocode-runtime::workflow`
3. `stale_branch.rs` -> `octocode-runtime::workflow`
4. `task_packet.rs` -> `octocode-core` + `octocode-runtime`

## 3. UI 与集成层目标映射

### Canvas UI Shell

不直接从 clawcode 迁移，属于 octocode 新增壳层，但必须只消费 runtime event bus。

### VS Code / Cline / Cursor

1. VS Code 优势 -> workspace、扩展宿主、终端/任务协同
2. Cline 优势 -> agent-driven task loop、文件/命令工作流
3. Cursor 优势 -> 聊天与编辑区联动、上下文触发体验

这些能力应映射为 integration facade，而不是复制对方内部实现。

## 4. 迁移顺序

### 第一批

1. provider routing
2. config dir / platform shell
3. session store
4. permission modes
5. tool registry

### 第二批

1. file ops
2. bash / powershell execution
3. CLI commands / slash commands
4. doctor / status / export / resume

### 第三批

1. MCP lifecycle
2. plugin / hooks / skills
3. workflow / recovery / lane events

### 第四批

1. Canvas UI shell
2. VS Code integration
3. Cline / Cursor compatibility bridge

## 5. Windows-first runtime 迁移清单

这份清单用于实现期持续验证，不允许最后集中补平台问题。

### 5.1 已经稳定到 crate 边界的接口

1. `octocode-core::ProviderCapabilities`
2. `octocode-core::ProviderFactory`
3. `octocode-core::PermissionPolicy`
4. `octocode-core::ToolCatalog`
5. `octocode-runtime::RuntimePermissionPolicy`
6. `octocode-runtime::RuntimeToolCatalog`

### 5.2 Claw Code -> Octocode 当前优先映射

1. `src/session_store.py` -> `octocode-runtime` session store 与 transcript persistence
2. `src/permissions.py` -> `octocode-core` permission contract + `octocode-runtime` enforcement
3. `src/runtime.py` 与 `src/remote_runtime.py` -> `octocode-runtime` orchestration 与 provider routing
4. `src/tool_pool.py` 与 `src/tools.py` -> `octocode-core` tool contract + `octocode-runtime` tool registry/executor
5. `src/transcript.py` 与 `src/history.py` -> `octocode-runtime` session transcript / history compaction
6. `src/server/` -> `octocode-cli` transport boot + 后续 UI shell event feed
7. `src/plugins/` 与 `src/hooks/` -> 后续 `octocode-runtime` plugin lifecycle 与 hook bridge

### 5.3 本轮后续必须持续验证的检查项

1. `cargo check` 必须保持通过。
2. `octocode-cli doctor` 要在 Windows 返回正确的 `APPDATA` / `LOCALAPPDATA` 派生路径。
3. `octocode-cli providers` 要返回统一 capability surface，而不是壳层私有字段拼装。
4. `octocode-cli tool shell-command ...` 要能在 Windows 上优先走 PowerShell，再按需退回其他 shell。
5. `serve` 输出的 WebUI state 必须继续包含 providers、tools、sessions、status、providerRoutes、eventFeed。

### 5.4 下一批迁移切片

1. 把 provider routing 从“单 provider + 描述列表”继续推进到显式 runtime router。
2. 把 session store 从当前文件实现拆出独立 runtime 子模块，补 Windows 路径与恢复测试。
3. 把 tool registry 从静态表继续拆成可扩展 registry，给后续 richer plugin hooks 留出入口。
4. 在 CLI parity 稳定后，继续让 Canvas UI 各区域只消费 runtime event/snapshot。
