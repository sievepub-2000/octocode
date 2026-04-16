# Octocode 当前实现状态

## 已完成

### 仓库与规划

1. 本地复制 clawcode 源仓库
2. 创建 GitHub 私有仓库 `octocode`
3. 写入重构总方案文档
4. 写入 clawcode 到 octocode 模块迁移映射

### 工程骨架

1. Rust workspace 初始化
2. `octocode-core`
3. `octocode-api`
4. `octocode-commands`
5. `octocode-runtime`
6. `octocode-cli`

### 当前运行能力

1. provider registry
2. provider selection via config / env fallback
3. platform-aware doctor
4. file-backed session store
5. file-backed session transcript store
6. session add / list / show / export
7. conversation append via `chat`
8. workspace read-file / list-files / write-file / shell-command
9. permission-gated tool execution
10. config init / config show
11. command parsing + command execution layer
12. status / doctor / tools / providers JSON output
13. UI snapshot export
14. 真实 OpenAI-compatible provider client
15. session resume / history trimming / tool result threading / provider error recovery
16. 本地 config 写回
17. 本地 interactive backend API (`/api/state`, `/api/health`, `/api/chat`, `/api/tool`, `/api/settings`, `/api/command`)
18. Canvas 渲染的系统白色背景工作台外壳
19. Wry 跨平台桌面壳（Windows WebView2 / macOS WebKit / Linux WebKitGTK）
20. provider health check + local-openai -> remote-openai -> stub 自动 fallback
21. provider circuit breaker：失败计数、冷却时间、半开自动恢复
22. sidebar / message list 改为 canvas 渲染，并带命中测试与内部滚动

### 当前验证通过项

1. `cargo check --workspace`
2. `cargo test -p octocode-api -p octocode-commands`
3. `status`
4. `doctor`
5. `providers`
6. `commands`
7. `session-add`
8. `chat`
9. `session-show`
10. `session-export`
11. `tools`
12. `tool read-file`
13. `tool write-file`
14. `tool shell-command` permission denial path
15. `ui-export`
16. `cargo run -p octocode-cli -- serve 4173 demo`
17. `http://127.0.0.1:999/ui-shell/` interactive WebUI real load check
18. `http://127.0.0.1:4173/api/state?session=demo`
19. `/api/settings` config writeback path
20. 原始前端资源核对：`index.html` / `app.js?v=4` 已切到 command palette、chat composer、provider settings、tool runner、terminal event log 新结构
21. `http://127.0.0.1:999/api/state?session=demo` 已确认输出 `circuitState` / `failureCount` / `cooldownRemainingMs`
22. `http://127.0.0.1:999/ui-shell/?session=demo` 已切到 `sidebar-canvas` / `message-canvas`

## 未完成

1. MCP lifecycle
2. plugin / skills / hooks
3. full slash-command parity
4. REPL
5. 组件级输入命中测试仍未覆盖到设置表单等 DOM 区域
6. VS Code / Cline / Cursor integration layer
7. 本地模型与闭源模型完整接入与 provider failover
8. release packaging
9. Windows/macOS 图形壳部署

## 当前里程碑定位

当前仓库已经从“静态 shell + 伪 provider”推进到“可编译、可运行、具真实 provider 接口、具交互式本地 backend、具工作流恢复语义的 runtime/workbench 阶段”。

## 当前同步状态

1. 本地最新实现仍可能受 GitHub 443 传输层波动影响
2. 当前应以本地提交与工作树状态为准确认进度

## 下一阶段优先级

1. 将 provider circuit breaker 从进程内状态推进到可观测/可持久化策略
2. command surface 扩充到 workflow / agent actions
3. REPL 与 conversation runtime 深化
4. MCP / tools / plugin parity
5. 从当前 Wry 桌面壳推进到发行版打包与自更新链路

## 当前风险说明

1. 用户指定模型端点 `http://192.168.110.2:8000/v1` 已经完成过 `/v1/models` 与一次 `/v1/chat/completions` 成功探测。
2. 本轮后续联调阶段，该端点出现了持续超时，因此当前交互式 chat API 会把 provider 错误写入 transcript，而不是返回模型内容。
3. 这说明 Octocode 的交互链路、错误恢复链路和 UI 展示链路已经工作；当前已具备熔断与自动恢复语义，但目标模型服务仍不稳定，后续仍需继续做 provider failover 观测增强或外部服务排障。
