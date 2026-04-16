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
