# Octocode 综合评估与同类项目对比分析报告

> 生成时间：2026-04 · 范围：`octocode/` 工作区 vs. `github/claude-code-{1,2,3}`
> 目的：回答“这是什么形态的 agent 系统？”“它怎么操作后台？CLI / API / IDE？”“每个模块的成熟度与改进优先级如何？”

---

## 0. 执行摘要（TL;DR）

| 维度 | 结论 |
|---|---|
| **系统形态** | 本地优先的 Rust 多面体（polymorphic）coding agent：**一个二进制 + 三种外观（CLI / Desktop / WebUI）+ 一套 HTTP+SSE+WebSocket API** |
| **后台操作方式** | **全部三种都支持，但"API-first"是核心**：`octocode-cli serve` 暴露 REST+SSE+WS API，TUI / Desktop / WebUI 均为这组 API 的消费者；并非 IDE 插件（非 LSP/非 VS Code Extension Host 寄生） |
| **同类项目定位** | `claude-code-2/3` = Anthropic Claude Code（Node.js，纯 TUI + IDE 子通道）；`claude-code-1` = `claw-code`（Rust 端口，Python 参考 + Rust 主线，仍在 parity 阶段） |
| **本项目独到优势** | WebUI 实时流式（SSE + WS 终端）+ 本地 PTY 接入 + 权限裙墙 + 多 provider 路由 + 单二进制分发，**不依赖 Node.js 运行时** |
| **短板** | 工具生态数量远少于 Claude Code（~10 vs. ~40+）；缺少 LSP / Notebook / Plan-Mode / Worktree 等高级工具；provider 覆盖窄；测试与文档分散 |
| **下一优先级** | (1) 工具覆盖（Glob/LSP/NotebookEdit/TodoWrite） (2) 规划模式 (3) 子 agent/Task 工具 (4) 打通 MCP 双向 (5) 提权与审计日志 |

---

## 1. 三个 `github/` 同类项目的实质

在评估 Octocode 之前，先界定参照系——它们彼此并不等价：

### 1.1 `github/claude-code-2/` — 官方分发产物
- **本质**：Anthropic 官方 npm 包 `@anthropic-ai/claude-code@2.1.88` 的**打包产物**（`cli.js` 混淆压缩 + `.map`），只有一个 `bin: { claude: "cli.js" }`。
- **运行依赖**：Node ≥ 18、可选 `sharp` 原生二进制（图像）。
- **使用方式**：`npx claude` / `claude` → 进入纯终端 TUI（Ink/React），向 `api.anthropic.com` 发请求，在用户当前 shell 中调用工具。
- **对比价值**：代表"主流 agent CLI"的**事实标准**——纯 TUI，无内置 HTTP 服务器。

### 1.2 `github/claude-code-3/` — TypeScript 源码侧面
- **本质**：与 claude-code-2 同一产品的 **TypeScript 源码侧面/复刻**（MIT，`sdk-tools.d.ts` + `src/tools/` 约 **40+ 工具**）。
- **信息密度**：可以读到每个工具的 schema 与实现，是 Octocode 工具覆盖评估的**黄金参照**。
- **覆盖的工具类别**（`src/tools/` 列目）：
  `AgentTool`, `AskUserQuestionTool`, `BashTool`, `BriefTool`, `ConfigTool`, `EnterPlanModeTool`/`ExitPlanModeTool`, `EnterWorktreeTool`/`ExitWorktreeTool`, `FileEditTool`, `FileReadTool`, `FileWriteTool`, `GlobTool`, `GrepTool`, `LSPTool`, `ListMcpResourcesTool`, `McpAuthTool`, `MCPTool`, `NotebookEditTool`, `PowerShellTool`, `ReadMcpResourceTool`, `RemoteTriggerTool`, `REPLTool`, `ScheduleCronTool`, `SendMessageTool`, `SkillTool`, `SleepTool`, `SyntheticOutputTool`, `TaskCreate/Get/List/Output/Stop/UpdateTool`, `TeamCreate/DeleteTool`, `TodoWriteTool`, `ToolSearchTool`, `WebFetchTool`, `WebSearchTool`。

### 1.3 `github/claude-code-1/` — `claw-code` / `ultraworkers/claw-code`
- **本质**：**第三方 Rust 端口**，双源码树并存：
  - `rust/crates/` — 正在对齐的 Rust 主线（`api`、`commands`、`runtime`、`tools`、`plugins`、`rusty-claude-cli`、`compat-harness`、`mock-anthropic-service`、`telemetry`）。
  - `src/` — 顶层 Python **参考实现**，用于 parity 回归（`PARITY.md`）。
- **实际状态**：`rust/crates/tools/src/` 只有 `lane_completion.rs`、`pdf_extract.rs`、`lib.rs` —— **工具几乎还没搬过去**，主要交付物仍在 Python 侧。
- **对比价值**：和 Octocode 最"方向相同"——都在用 Rust 重写一个 agent harness；但它更偏 **binary-parity**（对齐 Anthropic 官方行为），而 Octocode 更偏 **自主架构**。

### 1.4 三者关系一张图

```
        claude-code-2 (Node cli.js min)       ← 官方分发
              ▲
              │ 反向/同源
              │
        claude-code-3 (TS 源码 + 40+ tools)    ← 产品参照
              ▲
              │ 参考 / parity
              │
        claude-code-1 (Python 参考 + Rust 主线)← 第三方 Rust 端口
              ▲
              │ 方向同源但自立
              │
              Octocode (本项目, 8-crate Rust)   ← 本报告对象
```

---

## 2. Octocode 是什么形态的 Agent？

### 2.1 总体架构（已验证）

从 `Cargo.toml`（workspace 成员）和 `crates/octocode-cli/src/` 实测：

```
┌──────────────────────────────────────────────────────────────┐
│                       octocode-cli                            │
│   入口：main.rs → subcommands: chat | serve | desktop | tui   │
│   绑定了：server.rs (HTTP/SSE/WS) · desktop.rs (wry/tao 窗)   │
│            tui.rs (crossterm)    · terminal.rs (portable-pty) │
│            ws.rs (手写 WebSocket 握手 + 帧编解码)              │
│            tls.rs · manage_config.rs                          │
└──────────────────────────────────────────────────────────────┘
                │                │                │
                ▼                ▼                ▼
  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
  │octocode-cmds │   │octocode-rt   │   │ octocode-api   │
  │ (CLI parse)  │   │session/hooks │   │provider/router │
  │              │   │permission    │   │circuit-breaker │
  │              │   │tools/router  │   │streaming       │
  │              │   │subagent/task │   │                │
  │              │   │compaction    │   │                │
  └──────────────┘   └──────────────┘   └────────────────┘
                │                │                │
                ▼                ▼                ▼
  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
  │octocode-core │   │ octocode-mcp │   │octocode-skills │
  │ (domain)     │   │ (MCP client) │   │ (skill trait)  │
  └──────────────┘   └──────────────┘   └────────────────┘

  外挂：ui-shell/（纯 HTML+CSS+JS 单页 WebUI，作为 /ui-shell/ 静态资源由 server.rs 伺服）
```

**关键证据**
- 单二进制：`octocode-cli` 同时承载 `chat / serve / desktop / tui`，无外部 Node.js / Python 依赖。
- WebUI = 静态前端 + API 消费：`ui-shell/*.html|js|css` 被 `server.rs` 通过 HTTP 伺服，所有业务通过 `fetch()` + `EventSource` + `WebSocket` 调同一服务。
- 终端 = 真正的 PTY：`crates/octocode-cli/src/terminal.rs` 使用 `portable-pty` 起 PowerShell / bash 子进程，**不是模拟 shell**。WebSocket `/terminal/ws?id=X&token=Y` 双工透传（已实测 PASS：WS echo 回执包含 `hello-terminal-works`）。
- Runtime 能力（`crates/octocode-runtime/src/`）自带：`session`、`permission`+`permission_rules`、`router`、`coordinator`、`subagent`、`tasks`、`compaction`、`cost_tracker`、`hooks`、`snapshot_json`、`sqlite_store`、`todo_store`、`benchmarks`、`health_guardian`——**这张能力图在 claw-code 的 Rust 侧目前还是空的**。

### 2.2 后台操作模式：CLI / API / IDE？

> 短答：**既不是纯 CLI，也不是 IDE 插件；是 "本地 API 服务器 + 三个自带前端"。**

| 模式 | Octocode 实现 | 与 Claude Code 对比 |
|---|---|---|
| **CLI**（一次性命令） | ✅ `octocode-cli chat <session> "..."`；支持 `serve` / `desktop` / `tui` 子命令 | Claude Code 是**仅 CLI+TUI**，无 HTTP 服务器 |
| **API**（REST + SSE + WebSocket） | ✅ **核心交互层**：`/api/sessions/*`、`/api/chat/stream`（SSE）、`/api/terminal/*`、`/terminal/ws`、`/ui-shell/*` 静态；Bearer Token + query token 鉴权 | Claude Code **没有**本地 API server；有一个 `--sdk` 模式但面向 headless SDK，不伺服前端 |
| **IDE**（编辑器集成） | ⚠️ **没有**编辑器插件：不是 VS Code Extension、不是 JetBrains 插件、不跑 LSP | Claude Code 有 VS Code/JetBrains 伴生扩展（`IDE integration`，通过本地 socket 注入编辑器上下文）；`claude-code-3/src/` 有 `remote/`、`upstreamproxy/`、`voice/` 路径暗示更多集成 |
| **Desktop 壳** | ✅ `desktop.rs` 用 `tao + wry` 打开一个 webview 指向本机 `serve` 的 WebUI | Claude Code 无原生桌面壳 |
| **TUI** | ✅ `tui.rs` 用 `crossterm` 做纯终端 UI | Claude Code 主力就是 Ink（React-for-terminal）TUI |

**判定**：
Octocode 的后台操作模型 **≈ 本地 HTTP/WS 微服务 + 自带 WebUI 客户端**。CLI/TUI/Desktop 都是"同一服务器"的不同前端，`ui-shell/app.js` 作为**参考实现**（≈ 2600 行），把会话、流式消息、工具调用面板、终端 Drawer（xterm.js + PTY）、设置等集齐。这种形态更接近 **Open WebUI / LibreChat** 的私有 agent 版，而不是 Claude Code 的"纯终端 + IDE 伴生"形态。

---

## 3. 模块级深度评估

### 3.1 `octocode-runtime` — 核心大脑
**文件清单**：`session.rs`、`permission.rs` + `permission_rules.rs`、`router.rs`、`coordinator.rs`、`subagent.rs`、`tasks.rs`、`compaction.rs`、`cost_tracker.rs`、`hooks.rs`、`snapshot_json.rs`、`sqlite_store.rs`、`todo_store.rs`、`tool_call_parser.rs`、`tools.rs`、`memory.rs`、`health_guardian.rs`、`file_guard.rs`、`isolation.rs`、`benchmarks.rs`。

**评估**：
- ✅ **最成熟的一块**。比 claw-code 的 Rust 侧（基本只有 `lane_completion`、`pdf_extract`）完整一到两个数量级。
- ✅ 覆盖了 agent loop 的关键环节：会话存储（sqlite）、权限三档（Ask/WorkspaceWrite/FullAuto 类似 Claude 的 acceptEdits 模型）、hooks、子 agent、成本统计、健康守护。
- ⚠️ `tool_call_parser.rs` 暗示现在主要靠**文本模式解析 tool calls**（类似 ReAct / Anthropic 原始 tool_use JSON 解析），而非强类型 function-calling 协议。
- ⚠️ `isolation.rs` + `file_guard.rs` 需要确认"workspace 写入沙箱"是否真正执行（是否 hook 进了 FileEditTool 的路径校验）。
- ❌ 缺 **Plan Mode** 专属状态机（Claude Code 有 `EnterPlanModeTool`/`ExitPlanModeTool`，Octocode 没看到对应入口）。
- ❌ 缺 **Worktree** 隔离（Claude Code 的 `EnterWorktreeTool`/`ExitWorktreeTool` 允许 agent 在 git worktree 沙盒里试错）。

**优先级**：**A — 保持，扩面**。补齐 PlanMode、Worktree、更严格的 permission 审计日志。

### 3.2 `octocode-cli` — CLI + 服务器 + 终端
**现状**：
- 单二进制多入口：CLI 命令解析 → `server.rs`（HTTP/SSE/WS/静态）→ `terminal.rs`（PTY）→ `ws.rs`（自实现 WebSocket RFC 6455 握手 + 帧）→ `tls.rs` + `desktop.rs` + `tui.rs`。
- **自实现 WebSocket** 而不是用 `tungstenite`/`axum`/`actix-ws` —— 虽然减小了依赖面，但增加了维护成本与安全面（需要确认掩码、控制帧、关闭握手等均严格符合 RFC）。
- **自实现 HTTP server** 而不是 `hyper`/`axum` —— 同理，代码更薄但扩展性受限（中间件、keepalive tuning、HTTP/2、压缩等都得自己补）。

**评估**：
- ✅ 分发友好（无 runtime 依赖），冷启动快。
- ✅ 已实测：`/terminal/ws` 可以 echo 命令，PTY 正确出产 prompt。
- ⚠️ 自实现网络栈是**双刃剑**。对照 `claw-code/rust/crates/`，他们选用的是 `compat-harness` + 标准 crate 路线。
- ❌ `target-live-*`、`tmp-*.png`、`*.log` 在仓库根目录累积 **几十个 artifact**，没有 `.gitignore` 清理——工程卫生不良。

**优先级**：**A — 保持方向，做工程卫生 + 考虑换为 axum/hyper（长期）**。

### 3.3 `ui-shell/` — WebUI 前端
**现状（约 2600 行 `app.js`）**：
- 纯 vanilla JS + CSS，无打包，无 framework 依赖。`vendor/` 下自带 `xterm.js 5.x` + `xterm-addon-fit` UMD bundle。
- 跨 tab 会话隔离：`sessionStorage` + `BroadcastChannel`（上一轮已交付 commit `1fc3b13`）。
- 单页含消息流、工具调用折叠、终端 Drawer（可 tab 多个 PTY 会话）、设置、provider 切换。
- 本轮修复：① 用复制按钮替换原 "从这条消息 fork"（位置改右下、悬停可见、成功/失败状态）；② 终端面板渲染修复（pane 默认可见以让 xterm 测量、ResizeObserver 自适应、全区点击聚焦、二次 fit）。

**对比**：
- Claude Code 没有 WebUI 同等物；这是 Octocode 的**差异化亮点**。
- 技术选型"非常裸"（没有框架、没有构建工具），对 agent 产品是个有趣取舍：
  - 优点：体积小、易审计、无供应链风险、可以直接用 `cargo include_bytes!`-style 嵌入。
  - 缺点：2600 行单文件的可维护性门槛正在变高；i18n 文案的 `t(...)` 调用已经出现，但没抽出模块。

**优先级**：**B — 启动拆分**。建议：
1. 把 `app.js` 拆成 `core/session.js`、`ui/messages.js`、`ui/terminal.js`、`net/api.js`、`i18n/*.js` 等 ES modules（依旧不打包，浏览器原生 `<script type="module">`）。
2. `.msg-copy-btn`、`.msg-footer` 等已添加的样式做一轮 token 化（用 CSS 变量管理颜色/圆角/间距）。
3. 考虑引入 Web Components（`<oct-message>`, `<oct-terminal>`）做局部封装，保留零构建。

### 3.4 `octocode-api` — Provider 抽象层
**推断能力**：`router.rs`（见 runtime）暗示 provider 路由在 runtime 侧做，`octocode-api` 承载具体 provider 适配、circuit breaker、流式。

**评估**：
- ⚠️ **覆盖度未知**。Octocode 从 config 读 `provider_base_url`/`default_model`，默认 `local-openai`，暗示核心是"OpenAI 兼容端点"。相比之下：
  - Claude Code：原生 Anthropic Messages API + OAuth，且 `claude-code-3` 已把 WebSearch/WebFetch 落到官方 tool_use 协议。
  - `claw-code`：有 `mock-anthropic-service/` 专门打 Anthropic 协议兼容。
- ❌ 没有看到 **Anthropic / Gemini / Bedrock 原生适配**的痕迹。多 provider 的承诺在 README 里但在代码里可能只有一个 OpenAI-compat 实现。

**优先级**：**A** — 明确支持矩阵并补齐 Anthropic messages、Gemini generateContent、至少一个本地 llama.cpp 适配。

### 3.5 `octocode-mcp` — MCP 支持
**评估**：
- ✅ 独立 crate 说明把 Model Context Protocol 当一等公民。
- ⚠️ 需要确认是否支持 **bidirectional**（既做 MCP client 消费远端工具，又做 MCP server 把 octocode 工具导出）。Claude Code 两侧都做。
- 证据不足，需要读 `octocode-mcp/src/lib.rs` 进一步确认。

### 3.6 `octocode-plugins` / `octocode-skills`
**评估**：
- Plugins 和 Skills 分两个 crate，职责需要在 README 明确。`claude-code-3` 的 `SkillTool` 是 agent "能力二次加载"的关键——允许动态发现并装载 skill。
- Octocode `skills/*/SKILL.md` 已在仓库根存在（`spec-kit`、`vibecoding-guide`、`get-shit-down`、`autoresearch`），文件即规格，但运行时加载路径需要审计。

### 3.7 `octocode-commands` & `octocode-core`
- `commands`：CLI 子命令解析，应该薄，关注点正确。
- `core`：domain types，稳定。

### 3.8 `octocode-mock-provider`
- 用于测试/演示。✅ 与 claw-code 的 `mock-anthropic-service` 目的一致。

---

## 4. 工具（Tools）覆盖差距 —— 最大短板

### 4.1 对照表

| 分类 | claude-code-3 工具 | Octocode 状态 | 差距 |
|---|---|---|---|
| **文件 IO** | FileReadTool, FileWriteTool, FileEditTool, NotebookEditTool | 通过 `file_guard.rs` + runtime 实现基本读写编辑 | ❌ Notebook |
| **搜索** | GrepTool, GlobTool, ToolSearchTool | 有 grep；**Glob 缺失**，ToolSearchTool 缺失 | ❌ Glob/ToolSearch |
| **执行** | BashTool, PowerShellTool, REPLTool | 有 PTY（terminal.rs），相当于统一 Bash+PowerShell | ❌ REPL 状态保持 |
| **Web** | WebFetchTool, WebSearchTool | 未见实现 | ❌ 两个都缺 |
| **规划** | EnterPlanModeTool/ExitPlanModeTool, TodoWriteTool | `todo_store.rs` 有存储层，**缺 PlanMode 工具暴露** | ❌ PlanMode 工具未暴露 |
| **子 agent** | AgentTool, TaskCreate/Get/List/Output/Stop/UpdateTool | `subagent.rs` + `tasks.rs` 有运行时，**工具接口未对齐** | ❌ 工具名与 schema |
| **Worktree** | EnterWorktreeTool/ExitWorktreeTool | 缺 | ❌ |
| **用户交互** | AskUserQuestionTool, BriefTool | 缺 | ❌（WebUI 可以补） |
| **MCP** | ListMcpResourcesTool, ReadMcpResourceTool, McpAuthTool, MCPTool | 依赖 `octocode-mcp` crate，工具侧暴露未知 | ⚠️ 需要验证 |
| **LSP** | LSPTool | 缺 | ❌ |
| **调度** | ScheduleCronTool, SleepTool | 缺 | ❌ |
| **团队/远程** | TeamCreate/Delete, RemoteTriggerTool, SendMessageTool | 缺 | ❌（面向协作，后置） |
| **配置** | ConfigTool | `manage_config.rs` 是 CLI 层，不是 agent 可调用的 tool | ❌ 需 wrap 成 tool |

**结论**：Octocode 当前工具大约**覆盖 10–12 个等价**，对齐 Claude Code 需要**再补 25+ 个**。优先顺序见 §6。

---

## 5. 纵向对比矩阵

| 维度 | Octocode | claude-code-2/3 (Claude Code) | claude-code-1 (claw-code) |
|---|---|---|---|
| 语言/Runtime | Rust，单二进制 | Node.js ≥18 | Rust 主线 + Python 参考 |
| 前端形态 | CLI + TUI + WebUI + Desktop (wry) | TUI (Ink) + IDE 扩展 | CLI/TUI |
| 后台暴露 | **本地 HTTP+SSE+WS API**（:990-999） | 无本地 server；直连 Anthropic API | 无本地 server（正在 parity） |
| 鉴权 | Bearer Token（env 或自动生成，写到 stdout） | Anthropic API key / OAuth | Anthropic 鉴权 |
| 会话存储 | SQLite (`sqlite_store.rs`) | 本地 JSON + `~/.claude` | 混合 |
| 权限模型 | WorkspaceWrite/FullAuto/Ask（runtime 枚举） | acceptEdits / bypassPermissions / plan | 同步 Claude |
| Provider 抽象 | OpenAI-compat 为主，router+circuit breaker | Anthropic 原生 | Anthropic 原生为主 |
| 工具数量 | ~10–12 | ~40+ | Rust 侧 2；Python 侧 ~40 |
| MCP | 独立 crate（方向正确） | 一等公民（server+client） | 同步 Claude |
| Terminal/PTY | **portable-pty + WS 双工，WebUI 内嵌 xterm.js** | 在用户本地 shell 直接 fork | 同步 Claude |
| IDE 集成 | ❌ 无 | ✅ VS Code + JetBrains | ⚠️ 未完成 |
| Plan Mode | ❌ 无专用状态机 | ✅ | ✅ (Python 侧) |
| Worktree | ❌ | ✅ | ✅ (Python 侧) |
| Subagent/Task | ✅ runtime 完备，tool 暴露未完 | ✅ | ✅ (Python 侧) |
| 工程卫生 | ⚠️ 大量 `tmp-*`/`target-live-*` 入仓 | 成熟（官方打包） | 中（parity harness 存在） |
| 分发方式 | `cargo build -p octocode-cli` 单二进制 | `npm i -g @anthropic-ai/claude-code` | `cargo install`（有坑，见其 README） |

---

## 6. 改进优先级（按 ROI 排序）

### 🔴 P0 — 阻塞产品定位
1. **补齐基础工具集**：`GlobTool`, `NotebookEditTool`, `WebFetchTool`, `WebSearchTool`, `AskUserQuestionTool`, `TodoWriteTool`（基于已有 `todo_store.rs`）, `LSPTool`（为 IDE 对接铺路）。
2. **明确并固化 provider 适配矩阵**：至少保证 "OpenAI-compat / Anthropic Messages / 本地 llama.cpp" 三路互通，有专门测试。
3. **Plan Mode + Worktree 工具**：runtime 侧加状态机，工具侧暴露。
4. **MCP 双向**：验证 `octocode-mcp` 作为 MCP server 导出 Octocode 自身工具（使 VS Code 等 MCP client 能消费）。

### 🟠 P1 — 质量 & 工程成熟度
5. **网络栈评估**：决定保留自实现 HTTP/WS 还是迁移到 `axum + tokio-tungstenite`；若保留则补一套 **RFC 6455 兼容性测试**（掩码/分片/控制帧/close handshake）。
6. **工程卫生**：`.gitignore` 纳入 `target-live-*`、`tmp-webui-*.png`、`clippy*.log`、`cargo_*.txt`、`test_ws.ps1` 等；对根目录做一次大扫除。
7. **ui-shell 模块化**：按 §3.3 拆 ES modules。
8. **CI/测试矩阵**：workspace-wide `cargo test`、`clippy -D warnings`、WebUI smoke（headless Chromium CDP 打开 → 看首 prompt 出现 → 终端 echo）。

### 🟡 P2 — 扩面
9. **IDE 集成**：先做 VS Code 扩展 —— 它可以用 `octocode-cli serve` 作为远端而非 spawn 子进程，复用 WebSocket 终端通道与 MCP 双向，避免重写运行时。
10. **Cost/Quota 面板**：`cost_tracker.rs` 已存在，UI 端暴露为 panel。
11. **Skill 动态发现**：对齐 `SkillTool`，使 `skills/` 目录下 Markdown 可热加载。

### 🟢 P3 — 差异化
12. **协作类工具**：`SendMessage`、`RemoteTrigger`、`ScheduleCron` 可以做成 optional plugins（不是每个单机用户都需要）。
13. **沙盒容器**：对照 claw-code 的 `Containerfile`，提供官方 `podman/docker` 镜像。

---

## 7. 对"这是什么 agent 系统"的最终判定

Octocode 是一个 **Rust 实现的本地优先 agent 运行时**，采用 **"微服务化自包含" 架构**：
- 单二进制同时承担 **服务器、TUI、CLI、桌面壳**。
- **后台操作采用 HTTP+SSE+WebSocket API 驱动模型**（既不是 Claude Code 风格的"TUI 直接调外部 API"，也不是 VS Code Copilot 风格的"IDE 扩展寄生"）。
- 工具执行全部在 **本地进程+PTY** 里发生（已验证），对比下：
  - Claude Code：同样本地，但没有 HTTP 面。
  - Copilot CLI / Cursor：远端 agent loop。
- 结果是：Octocode 更像 **"私有化部署的 agent 后端 + 参考 WebUI"**，而不是"另一个 Claude Code"。这个定位解释了为什么 `serve`/`desktop` 子命令是一等公民、而 IDE 扩展暂付阙如。

在 `github/` 三个参照里，Octocode 没有一个 1:1 对应物：
- 外观像 `claude-code-1`（Rust 端口），但 **架构方向不同**（claw 对齐 Claude 行为，Octocode 自立门户）。
- 能力想对齐 `claude-code-3`（40+ 工具），但**目前只到 25%**。
- **差异化优势** = WebUI + 本地 API 服务 + PTY 直连——这是 Claude Code 生态里没有的形态。

保持这个差异化优势并补齐工具覆盖，就是 Octocode 未来 1-2 个里程碑的主线。

---

## 附录 A：本轮 UI 修复摘要
- **复制按钮**：`ui-shell/app.js` `renderMessages()` 移除 "从这条消息 fork"，新增 `.msg-footer` 右下复制按钮（Clipboard API + `execCommand` 回退，视觉反馈）。
- **终端面板修复**：`ensureTerminalPane()` 让 pane 默认可见（避免 xterm.js 打开 0×0 容器），添加 `mousedown` 聚焦；`renderTerminalUi()` 加 `ResizeObserver` 自适应、二次 fit、抽屉级 click-to-focus。
- **后端验证**：新起 `octocode-cli serve --port 999`，REST + WebSocket 全链路 echo 通过（`hello-terminal-works` 返回）。

## 附录 B：未决事项
- 上一轮 commit `1fc3b13`（cross-tab 隔离 + 并发 turn guard）以及本轮 UI 修改均**尚未 push**（`github.com:443` 之前不可达；下一次网络恢复后一起推）。
- `octocode-api` 的实际 provider 覆盖需要进 `crates/octocode-api/src/` 确认后再补 §3.4 的断言。
