# Octocode 参考仓库综合研究与再开发方案

## 1. 输入材料

本轮研究基于以下四个本地参考仓库：

1. `github/claude-code-1`
2. `github/claude-code-2`
3. `github/claude-code-3`
4. `github/claude-code-learn`

其中：

1. `claude-code-1` 提供官方公开产品面、插件目录与安装入口。
2. `claude-code-2` 提供恢复后的完整源码树，覆盖 `commands/`、`tools/`、`services/mcp/`、`coordinator/`、`skills/`、`plugins/` 等高价值模块。
3. `claude-code-3` 提供更直接的 `src/ + vendor/` 项目布局，有利于抽取主循环、工具注册、SDK 边界。
4. `claude-code-learn` 提供公开资料汇总后的架构研究，可用来验证源码观察到的设计模式是否具有系统性。

## 2. 语言选型结论

### 结论

Octocode 主体继续采用 Rust。

### 原因

1. 当前 Octocode 已经具备 Rust workspace 与多 crate 分层基础，整体迁移到 Go 或 Zig 的重写成本过高。
2. Rust 更适合承载 runtime、permissions、tool orchestration、provider routing、MCP lifecycle 这类高并发、强类型、跨平台核心层。
3. Go 在网络服务与开发效率上有优势，但对当前 CLI + provider + desktop + workspace runtime 的类型约束帮助不如 Rust。
4. Zig 适合极限性能与底层控制，但生态、开发效率与跨平台应用层整合不适合本项目现阶段。

### 推荐形态

1. Rust：runtime、tools、providers、permissions、MCP、session、workflow。
2. TypeScript：UI、扩展宿主、SDK、外部桥接层。

## 3. 从参考仓库提炼出的高价值能力

### P0

1. MCP 生命周期：manifest 发现、trust gate、spawn、ready、running、tool bridge。
2. 多 agent 协调：Task registry、team / teammate、sub-agent orchestration。
3. 工具系统扩展：AgentTool、MCPTool、WebFetchTool、LSPTool、NotebookTool、TaskTool。

### P1

1. 技能系统：skill registry、skill loader、skill executor。
2. 权限系统细化：工具级权限、拒绝追踪、审批路径。
3. 事件总线统一：CLI / HTTP / UI / workflow 全量消费同一 runtime truth。

### P2

1. 远程会话与桥接。
2. 更完整的 VS Code / SDK 集成。
3. 更高级的 workflow / coordinator 模式。

## 4. 当前 Octocode 与目标态差距

### 已具备

1. Rust monorepo 分层。
2. provider router + circuit breaker。
3. file-backed session store。
4. 本地 WebUI 与桌面壳层。
5. runtime snapshot / event feed。

### 仍缺失

1. MCP 执行层与 transport bridge。
2. 多 agent registry 与任务状态机。
3. 25+ 级工具面。
4. 技能与插件的真正运行时注入。
5. 更细的权限与策略持久化。

## 5. 第一批实现切片

### Slice A：MCP 生命周期骨架

1. 新增 `octocode-mcp` crate。
2. 定义 manifest 发现与生命周期状态机。
3. 暴露 `mcp list` 命令，先把“发现 -> 状态 -> 命令面”打通。

### Slice B：多 agent 任务骨架

1. 新增 task 类型与 registry。
2. 接入 `agent` / `workflow` 命令。
3. 输出结构化任务状态。

### Slice C：工具面扩充

1. 增加 `web-fetch`、`agent-tool`、`mcp-tool`、`task-tool` 等。
2. 让 HTTP / CLI / UI 三个表面共享同一工具目录。

### Slice D：权限收口

1. 工具级规则。
2. YAML 或 conf 持久化。
3. 拒绝追踪与可观测性。

## 6. 本轮已执行结果

1. 已确认 `claude-code-2` 与 `claude-code-3` 仓库页面确实包含完整代码目录与关键文件。
2. 已通过 GitHub codeload zip 将三个参考仓库完整同步到本地。
3. 已在 Octocode 中启动 Slice A：新增 MCP 发现与生命周期骨架。
4. 已在 Octocode 中启动第二个研究切片：新增 local skill discovery，打通 `skills` 命令面。

## 7. 下一步计划

1. 将 MCP manifest 从“发现”推进到“spawn + health + tool bridge”。
2. 新建 task / coordinator crate，补齐多 agent 协调。
3. 把工具面从当前 15 个扩展到 25+。
4. 将 UI 与 HTTP 表面对 MCP / task / tools 的新状态可视化。