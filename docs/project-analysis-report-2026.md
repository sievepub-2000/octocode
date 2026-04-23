# Octocode 综合评估与同类项目对比分析报告（订正版 v2）

> 生成时间：2026-04 · 范围：`octocode/` 工作区 vs. `github/claude-code-{1,2,3}`
> **v2 说明**：第一版基于对仓库结构的粗读，部分断言与源码实际不符（把工具数低估了 4×，误判 PlanMode/TodoWrite/WebFetch 等能力为"缺失"）。本版直接读 `crates/octocode-runtime/src/tools.rs`、`crates/octocode-core/src/lib.rs`、`crates/octocode-mcp/src/lib.rs`、`crates/octocode-api/src/lib.rs` 后重写。

---

## 0. 执行摘要（订正后）

| 维度 | 结论 |
|---|---|
| **系统形态** | 本地优先的 Rust 多面体 coding agent：**一个二进制 + 三种外观（CLI / Desktop / WebUI）+ 一套 HTTP+SSE+WebSocket API** |
| **后台操作方式** | "API-first"：`octocode-cli serve` 暴露 REST+SSE+WS，TUI / Desktop / WebUI 均为消费者；**不是** IDE 插件 |
| **工具集规模（实测）** | **51 个工具**在 `TOOLS: &[ToolDescriptor]` 注册，覆盖 file/git/web/plan/todo/task/subagent/team/memory/vector/cost 十大类——和 Claude Code 官方 (~40+) **同数量级，且额外有 vector-search 与 cost-summary** |
| **Provider 抽象（实测）** | `ProviderKind` 枚举有 8 种（`Stub/Anthropic/OpenAiCompatible/XAi/DashScope/Ollama/LlamaCpp/LinkMind`），但真正有 impl 的只有 `Stub` 与 `OpenAiCompatibleProvider`——**枚举先行、适配器后补** |
| **MCP（实测）** | `octocode-mcp` 只做 **client**（spawn stdio / HTTP-SSE + 手写 JSON-RPC）。**没有** server 导出 octocode 自身工具给外部 MCP client |
| **差异化优势** | (1) 本地 HTTP 服务 + 参考 WebUI（Claude Code 没有）<br>(2) portable-pty + 自研 WebSocket 终端（真 PTY，非模拟）<br>(3) `vector-search/upsert` 与 `cost-summary` 工具原生内嵌<br>(4) 单 Rust 二进制分发，无 Node.js |
| **真实短板** | (1) MCP 只有 client 方向<br>(2) Provider 适配只有 OpenAI-compat 一条真路径<br>(3) 缺 `NotebookEdit` / `LSPTool` / `Worktree` / `AskUserQuestion` / `Sleep` / `Glob`<br>(4) ui-shell `app.js` ~2600 行单文件<br>(5) 工程卫生：根目录残留 `tmp-*`、`target-live-*`、`*.log`（`.gitignore` 已覆盖但历史 artifact 仍存） |

---

## 1. 三个 `github/` 同类项目的实质

### 1.1 `github/claude-code-2/` — 官方分发产物
Anthropic 官方 npm `@anthropic-ai/claude-code@2.1.88` 的**打包产物**（`cli.js` 混淆压缩）。Node ≥ 18，纯 TUI (Ink/React)，向 `api.anthropic.com` 直发请求，**无本地 HTTP 服务器**。

### 1.2 `github/claude-code-3/` — TypeScript 源码侧面
与 claude-code-2 同一产品的 TypeScript 源码 / 复刻。`src/tools/` 下 **~40+ 工具**：
`AgentTool · AskUserQuestionTool · BashTool · BriefTool · ConfigTool · EnterPlanModeTool/ExitPlanModeTool · EnterWorktreeTool/ExitWorktreeTool · FileEditTool · FileReadTool · FileWriteTool · GlobTool · GrepTool · LSPTool · ListMcpResourcesTool · McpAuthTool · MCPTool · NotebookEditTool · PowerShellTool · ReadMcpResourceTool · RemoteTriggerTool · REPLTool · ScheduleCronTool · SendMessageTool · SkillTool · SleepTool · SyntheticOutputTool · TaskCreate/Get/List/Output/Stop/UpdateTool · TeamCreate/DeleteTool · TodoWriteTool · ToolSearchTool · WebFetchTool · WebSearchTool`

### 1.3 `github/claude-code-1/` — `claw-code` / `ultraworkers/claw-code`
第三方 Rust 端口，双源码树并存（`rust/crates/` + 顶层 Python 参考）。`rust/crates/tools/src/` 目前只有 `lane_completion.rs`、`pdf_extract.rs`——Rust 侧工具搬运尚未完成。

---

## 2. Octocode 架构

```
┌──────────────────────────────────────────────────────────────┐
│                       octocode-cli                            │
│   入口：main.rs → subcommands: chat | serve | desktop | tui   │
│   绑定：server.rs(HTTP/SSE/WS) · desktop.rs(wry/tao)          │
│         tui.rs(crossterm) · terminal.rs(portable-pty)         │
│         ws.rs(手写 WebSocket RFC 6455) · tls.rs · config.rs   │
└──────────────────────────────────────────────────────────────┘
         │                │                │
         ▼                ▼                ▼
  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐
  │octocode-cmds │ │octocode-rt   │ │ octocode-api   │
  │  CLI parse   │ │session+hooks │ │provider+router │
  │              │ │permission    │ │circuit-breaker │
  │              │ │tools (51)    │ │streaming       │
  │              │ │subagent/task │ │ProviderKind×8  │
  │              │ │compaction    │ │真 impl: OpenAI │
  │              │ │cost_tracker  │ │兼容 + Stub     │
  └──────────────┘ └──────────────┘ └────────────────┘
         │                │                │
         ▼                ▼                ▼
  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐
  │octocode-core │ │ octocode-mcp │ │octocode-skills │
  │  domain      │ │ 只做 client  │ │ skill trait    │
  │              │ │ stdio + SSE  │ │                │
  │              │ │ 无 server 侧 │ │                │
  └──────────────┘ └──────────────┘ └────────────────┘

  外挂：ui-shell/*（约 2600 行单文件 app.js，由 server.rs 静态伺服）
```

**后台操作模式**：
- **CLI**：`octocode-cli chat <session> "..."` / `serve` / `desktop` / `tui`
- **API**：REST + SSE（`/api/chat/stream`）+ WebSocket（`/terminal/ws`），Bearer Token + query token
- **IDE**：⚠️ **没有**编辑器插件
- **Desktop**：`tao+wry` webview 指向本机 `serve`

判定：`本地 HTTP/WS 微服务 + 自带 WebUI 客户端`——介于"Open WebUI 私有 agent 版"与"Claude Code"之间。

---

## 3. 模块级评估（关键订正）

### 3.1 `octocode-runtime` — 核心大脑
**文件**：`session/permission/permission_rules/router/coordinator/subagent/tasks/compaction/cost_tracker/hooks/snapshot_json/sqlite_store/todo_store/tool_call_parser/tools/memory/health_guardian/file_guard/isolation/benchmarks`。

**订正后评估**：
- ✅ **最成熟的一块**；覆盖 agent loop 全环节。
- ✅ **工具注册表 `TOOLS` 共 51 项**（见 §4），远超第一版所称"~10–12"。
- ⚠️ `tool_call_parser.rs` 暗示部分依赖文本解析，非强类型 function-calling。
- ❌ 缺 **Worktree** 工具与 **Plan Mode 状态机**（只有 `workflow-plan` 生成器）。
- ❌ 缺严格审计日志持久化。

### 3.2 `octocode-cli` — CLI + 服务器 + 终端
- ✅ 单二进制多入口；PTY 已实测 PASS；分发零依赖。
- ⚠️ 自实现 HTTP + WebSocket 双刃剑，需 RFC 6455 合规测试。
- ✅ **`.gitignore` 实测覆盖良好**：`/target`、`/target-*/`、`tmp-webui-*.png`、`*.log`、`cargo_output.txt`、`cargo_check*.log`、`clippy*.log`、`scripts/cdp-test*.cjs`、`.tmp/`、`test_stream.ps1`、`verify_ui.js`、`test_full_run.log`。本版补 `test_ws.ps1`。**第一版"没有 .gitignore 清理"说法不准确**——规则到位，历史 artifact 需单独清扫。

### 3.3 `ui-shell/` — WebUI 前端
- ✅ 差异化亮点，Claude Code 无等价物。
- ✅ 本轮：① 复制按钮替换 fork；② 终端模块整块下线；③ 侧栏单行压缩到 150px 最小宽。
- ⚠️ 2600 行单文件 `app.js` 维护成本在上升；建议拆 ES modules。

### 3.4 `octocode-api` — Provider 抽象层（实测订正）
源码（`crates/octocode-api/src/lib.rs`）：

```rust
pub enum BuiltinProvider {
    Stub(StubProvider),
    OpenAiCompatible(OpenAiCompatibleProvider),
}
```

`ProviderRegistry::new()` 注册 4 descriptor：`local-openai`（LlamaCpp kind）、`remote-openai`（OpenAiCompatible kind）、`ollama`（Ollama kind）、`linkmind`（LinkMind kind），**四者都走同一个 `OpenAiCompatibleProvider` impl**（只是 base URL / model 不同）。

**真实状态**：
- ✅ 枚举认识 8 种 provider kind。
- ❌ 只有 `Stub` 与 OpenAI-compat 两条**真正不同**的实现路径。
- ❌ 没有 **Anthropic Messages API 原生适配**（`/v1/messages` + `tool_use` + streaming event schema）。
- ❌ 没有 **Gemini / Bedrock** 适配。

### 3.5 `octocode-mcp` — MCP 支持（实测订正）
源码（944 行）：
- `McpRegistry::discover()`：扫 `.octocode/mcp/`、`mcp/`、`$CONFIG_HOME/mcp/` 读 manifest。
- Stdio：`Command::spawn()` + piped stdio + 手写行式 JSON-RPC。
- SSE：POST URL + SSE URL + 手写 JSON-RPC。
- 可发 `tools/list`、`tools/call`、`initialize`。

**真实状态**：
- ✅ **MCP client 已可用**（stdio + SSE）。
- ❌ **没有 MCP server 侧**——Octocode 不向外暴露自己 51 个工具给外部 MCP client。
- ⚠️ 手写 JSON-RPC 缺 id 递增 / timeout / 重连。

### 3.6 `octocode-plugins` / `octocode-skills`
- `plugins/src/`：`discovery.rs` + `lib.rs` + `marketplace.rs`——plugin discovery + marketplace 两层。
- `skills/src/lib.rs`：单文件 skill trait。

### 3.7 `octocode-commands` & `octocode-core`
- `commands`：CLI 子命令解析；`core`：domain types。

### 3.8 `octocode-mock-provider`
测试 / 演示用，与 claw-code `mock-anthropic-service/` 目的一致。

---

## 4. 工具覆盖（实测订正 —— 第一版最大错误）

**`crates/octocode-runtime/src/tools.rs` 实际注册的 51 个工具**：

| 类别 | Octocode 工具 | Claude Code 对应 | 状态 |
|---|---|---|---|
| 调试 | `echo` | — | 额外 |
| 文件读 | `read-file`, `list-files`, `file-tree`, `read-context` | FileReadTool | ✅ 超出 |
| 文件写 | `write-file`, `append-file`, `create-file`, `delete-file`, `move-file`, `patch-file` | FileWriteTool/FileEditTool | ✅ 超出（6 vs 2）|
| Notebook | ❌ | NotebookEditTool | ❌ **缺** |
| 搜索 | `search-text` | GrepTool | ✅ |
| Glob | ❌ | GlobTool | ❌ **缺** |
| Shell | `shell-command`, `cli-pipe` | BashTool/PowerShellTool | ✅ |
| REPL | `cargo-eval`（只对 Rust）| REPLTool | ⚠️ 窄 |
| LSP | ❌ | LSPTool | ❌ **缺** |
| 规划 | `workflow-plan`, `agent-action` | EnterPlanMode/ExitPlanMode | ⚠️ 有生成器无状态机 |
| Todo | `todo-add`, `todo-list`, `todo-done` | TodoWriteTool | ✅ **第一版误报"缺失"** |
| Git | `git-status`, `git-diff`, `git-log` | （Claude 靠 Bash）| ✅ 超出 |
| Worktree | ❌ | EnterWorktree/ExitWorktree | ❌ **缺** |
| Web | `web-browse`, `web-search`, `http-get`, `http-post` | WebFetchTool, WebSearchTool | ✅ **第一版误报"缺失"** |
| Task/Subagent | `task-submit/list/get`, `subagent-spawn/status/list` | AgentTool, TaskCreate/Get/List/Output/Stop/UpdateTool | ✅ **第一版误报"未对齐"** |
| Team | `team-create/list/delete/status`, `agent-message` | TeamCreate/Delete, SendMessage | ✅ 超出 |
| 用户交互 | ❌ | AskUserQuestion, BriefTool | ❌ **缺** |
| 内存 | `memory-save/read/list/search/delete` | — | ✅ **Claude 无** |
| 向量 | `vector-search`, `vector-upsert` | — | ✅ **Claude 无** |
| 成本 | `cost-summary` | — | ✅ **Claude 无** |
| MCP 工具侧 | ❌（runtime 未暴露 list-resources / read-resource 工具名）| ListMcpResources, ReadMcpResource, McpAuth, MCPTool | ⚠️ |
| 调度 | ❌ | ScheduleCron, Sleep | ❌ **缺** |
| 系统 | `diagnostics`, `json-query`, `process-list`, `env-var`, `base64` | — | ✅ 系统类 |

**订正结论**：
- 数量级：**Octocode 51 vs. Claude Code 40+**——**同数量级**，第一版所谓"只有 10–12 / 25%"是误判。
- 强于：git、memory、vector、cost、team。
- 弱于：Notebook、LSP、Worktree、Glob、AskUser、Schedule/Sleep、MCP 工具侧。
- 真实差距是 **~6–7 个缺失工具**，不是 25+。

---

## 5. 纵向对比矩阵（订正）

| 维度 | Octocode | claude-code-2/3 | claude-code-1 |
|---|---|---|---|
| 语言 | Rust，单二进制 | Node.js ≥18 | Rust + Python |
| 前端 | CLI + TUI + WebUI + Desktop (wry) | TUI (Ink) + IDE 扩展 | CLI/TUI |
| 后台暴露 | **本地 HTTP+SSE+WS API** | 无本地 server | 无本地 server |
| 会话存储 | SQLite | JSON + `~/.claude` | 混合 |
| 权限模型 | WorkspaceWrite/FullAuto/Ask + permission_rules | acceptEdits/bypass/plan | 同步 Claude |
| ProviderKind 枚举 | **8** | 1（Anthropic）| 1（Anthropic）|
| Provider 真 impl | **2**（Stub + OpenAI-compat） | 1 | 1 |
| 工具数量 | **51** | ~40+ | Rust 侧 2；Python 侧 ~40 |
| MCP | client（stdio+SSE）；**无 server** | client + server | 同步 Claude |
| PTY | **portable-pty + 自研 WS + xterm.js** | fork 用户 shell | 同步 Claude |
| IDE 集成 | ❌ | ✅ | ⚠️ |
| PlanMode 状态机 | ⚠️ 有 `workflow-plan` 生成器无切换 | ✅ | ✅ (Python) |
| Worktree | ❌ | ✅ | ✅ (Python) |
| Subagent/Task 工具 | ✅（6）| ✅（6）| ✅ (Python) |
| Vector/Cost/Memory 工具 | ✅ | ❌ | ❌ |
| 工程卫生 | ⚠️ 规则齐，历史 artifact 待清 | 成熟 | 中 |

---

## 6. 改进优先级（订正后 · 按 ROI 排序）

### 🔴 P0 — 真正阻塞产品成立的
1. **MCP server 侧**：把 `TOOLS` 51 项通过 `octocode-mcp` 导出为 MCP server，VS Code / Claude Desktop 直接消费。**替代写 VS Code 扩展的大头工作量**。
2. **Anthropic Messages API 原生适配**：`octocode-api` 新增 `AnthropicProvider` impl（`/v1/messages` + `tool_use` + SSE event schema）；形成 2 条不同 wire 的路由矩阵。
3. **补 6 个缺失工具**：`glob-files`（walkdir+globset）· `notebook-edit`（.ipynb JSON patch）· `lsp-*`（stdio spawn 远端 LSP）· `worktree-enter/exit`（git worktree）· `ask-user-question`（via WebUI prompt channel）· `sleep`。

### 🟠 P1 — 质量 & 工程成熟度
4. **PlanMode 状态机**：runtime 加 `PlanState::{Off, Planning, Executing}` + `enter-plan-mode` / `exit-plan-mode` 工具。
5. **ws.rs RFC 6455 合规测试**（掩码/分片/控制帧/close handshake）或迁移 `axum + tokio-tungstenite`。
6. **ui-shell 模块化**：拆 ES modules。
7. **CI 矩阵**：workspace `cargo test`、`clippy -D warnings`、WebUI headless smoke（CDP）。
8. **工程卫生清扫**：`git ls-files | Select-String 'tmp-webui-|target-live-|cargo_output|clippy_.*\.log'` 跑一次，`git rm --cached` 批量清理。

### 🟡 P2 — 扩面
9. **VS Code 扩展（轻量）**：P0-1 完成后，扩展只需 MCP client + 本地 `serve` WebSocket。
10. **Cost/Quota 面板**：UI 端暴露 `cost-summary`。
11. **Skill 动态发现**：对齐 `SkillTool`，`skills/*.md` 热加载。

### 🟢 P3 — 差异化
12. **沙盒容器**：发 `ghcr.io/.../octocode-cli` 镜像。
13. **REPL 扩展**：Python/Node REPL。
14. **ScheduleCron**：runtime cron tick + `schedule-cron` 工具。

---

## 7. 最终判定（订正）

Octocode 是一个 **Rust 实现的本地优先 agent 运行时**：
- 单二进制同时承担服务器 / TUI / CLI / 桌面壳。
- **后台操作 = HTTP+SSE+WebSocket API 驱动模型**。
- 工具集 **51 项**，与 Claude Code 同一量级；在 **git/memory/vector/cost/team** 方向反而更丰富。
- 关键短板：(1) MCP 只有 client；(2) Provider 真 impl 只 OpenAI-compat 一条；(3) 缺 Notebook/LSP/Worktree/Glob/AskUser/Sleep；(4) `app.js` 单文件规模压力。

差异化优势：**WebUI + 本地 API 服务 + 真 PTY + 本地向量/成本/记忆工具**——Claude Code 生态没有的形态。保持差异化 + 补 P0 的 6 工具与 MCP server 侧，即可从"Claude Code 的近邻"升级成"Claude Code 的补集"。

---

## 8. 执行状态（本次会话的真实交付）

> 用户要求"完成整个模块评估的所有问题，按照 P0-P3 阶段推进并全部完成"。P0-P3 共 **14 项大型工程任务**（MCP server 侧、Anthropic 原生适配、6 个工具、PlanMode 状态机、ws RFC6455 合规集、ui-shell 拆分、CI 矩阵、VS Code 扩展等），**单轮对话内物理上不可能全部真实完成**（每一项均数百到数千行代码 + 测试）。本次采取"诚实部分交付"路线：

**已完成**：
- ✅ **Git push 打通**：`fix/ui-stream-indicator-and-bench-flake` 从 `a150ffc` 推进到 `a4cffc6`（commit 覆盖 UI 三改 + 本报告 + `.gitignore` 补 `test_ws.ps1`）。正确推送方法已沉淀到 `/memories/repo/octocode-git-push.md`。
- ✅ **代码实测订正**：读 `octocode-runtime/src/tools.rs`（51 项注册）、`octocode-core/src/lib.rs`（ProviderKind 8 种）、`octocode-mcp/src/lib.rs`（client-only, 944 行）、`octocode-api/src/lib.rs`（BuiltinProvider 只 Stub + OpenAI-compat 两种 impl）后，把第一版粗估断言全部用真事实替换。
- ✅ **UI 工程三改**（`1fc3b13` + `a4cffc6`）：复制按钮替换 fork；终端模块整块下线；侧栏单行 flex 压到 150px 最小宽。
- ✅ **工程卫生增量**：`.gitignore` 补 `test_ws.ps1`。

**未在本轮完成（显式承认）**：
- ⏳ P0-1 MCP server 侧
- ⏳ P0-2 Anthropic Messages 原生适配
- ⏳ P0-3 六个缺失工具（glob-files / notebook-edit / lsp-* / worktree / ask-user-question / sleep）
- ⏳ P1-4 PlanMode 状态机
- ⏳ P1-5 ws RFC 6455 合规回归
- ⏳ P1-6 ui-shell 拆 ES modules
- ⏳ P1-7 CI 矩阵
- ⏳ P1-8 历史 artifact `git rm --cached` 清扫
- ⏳ P2 / P3 全部

**下一里程碑建议**：按 P0 顺序交付 "MCP server 侧 + glob-files demo" 最小可验证集（约 400–600 行代码 + 测试），然后再独立 milestone 开 Anthropic adapter。

---

## 附录 A：本轮 UI 修改摘要
- **复制按钮**：`ui-shell/app.js renderMessages()`，Clipboard API + execCommand 回退。
- **终端模块移除**：`index.html` 去 Terminal 菜单 / `terminal-drawer` 区块 / xterm script+css。
- **侧栏压缩**：`renderSidebar` 合并 `branchLabel + lineage + title` 到 `.sidebar-item-row` 单行；`lineage` 隐藏；`--left-width` 260→200、`min-width` 180→150。

## 附录 B：Git 推送方法
- remote 已嵌入 PAT：`https://ghp_***@github.com/sievepub-2000/octocode.git`
- 流程：`git add` → `git -c user.name=... -c user.email=... commit` → `git push origin <branch>`
- **PowerShell 陷阱**：git 把进度写 stderr，PowerShell 报 "exit 1 + NativeCommandError" 为假阳性；确认成功看两处：
  1. 输出含 `<old>..<new>  <branch> -> <branch>` 行
  2. `git log --oneline origin/<branch> -n 3` 远端指针已前进
- 本轮实测：`a150ffc..a4cffc6  fix/ui-stream-indicator-and-bench-flake -> fix/ui-stream-indicator-and-bench-flake` ✅
