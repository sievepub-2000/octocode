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
23. explicit runtime provider router：主 provider / 备用 provider / stub route chain
24. runtime 子模块拆分：session / permission / tool registry / router
25. CLI parity 新增 `routes` 与 `snapshot`
26. unified runtime event feed：CLI / HTTP / Canvas UI 共享同一条 runtime event surface
27. Canvas terminal / provider 面开始只消费 runtime snapshot + `/api/events`
28. Canvas settings summary / tool shell / composer summary 继续切到 runtime snapshot + `/api/events`，移除更多 UI 侧业务状态回推
29. `snapshot --json` 扩展为更完整的 unified runtime surface，不再只返回摘要对象
30. Windows desktop bundle 打包链路可生成版本化产物
31. Windows IExpress 安装器链路可生成可静默安装的 setup.exe
32. 已安装版本的 CLI、WebUI 与核心 API 已完成真实回归
33. Composer slash-command 已切到统一 runtime snapshot/event feed 与 `/api/command` / `/api/events` 路由
34. macOS 安装器脚本已补齐 `.app` + `.pkg` + `.dmg` 生成链路
35. Linux 安装器脚本已补齐 `.tar.gz` + `install.sh` 生成链路
36. provider health probe 已加入短 TTL 缓存，snapshot / doctor / reload 等路径不再反复阻塞远端探测
37. WebUI / HTTP 回归脚本 `scripts/test-regression.ps1` 已覆盖 chat / tool / settings / slash-command / 静态资源 / 路径防护
38. Canvas settings / tool / terminal tabs 已进一步收口到统一 snapshot + event feed，并补齐 workflow 时间线视图
39. REPL / slash-command 新增 `pipe` 多步命令组合，HTTP 响应会返回结构化 `steps` 结果与每步耗时
40. 新增 `octocode-mcp` crate，补齐 MCP manifest 发现、生命周期状态机骨架与 `mcp list` CLI 面
41. 新增 `octocode-skills` crate，补齐本地 `skills/*/SKILL.md` 与 `config_home/skills/*/SKILL.md` 发现能力，并暴露 `skills` CLI 面

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
23. `cargo run -p octocode-cli -- routes`
24. `cargo run -p octocode-cli -- snapshot demo`
25. session 子模块回归：`session-add` / `chat` / `session-show` / `session-export`
26. `cargo run -p octocode-cli -- events demo`
27. `http://127.0.0.1:999/api/events?session=demo` 已确认输出 `items` / `scope` / `message`
28. `http://127.0.0.1:999/api/state?session=demo` 已确认输出 `eventFeed` / `providerRoutes` / `activeSession`
29. `cargo run -p octocode-cli -- --json snapshot demo` 已确认输出 `status` / `providers` / `providerHealths` / `providerCircuits` / `providerRoutes` / `commands` / `tools` / `sessions` / `eventFeed` / `activeSession`
30. `http://127.0.0.1:999/ui-shell/?session=demo` 已确认 live Canvas shell 继续加载 `sidebar-canvas` / `message-canvas` / `composer-canvas` 与 `app.js`
31. `powershell -File .\scripts\package-desktop.ps1 -Profile release` 已生成 `out/desktop/octocode-v0.1.0-windows-x64`
32. `powershell -File .\scripts\package-windows-installer.ps1 -Profile release` 已生成 `out/installers/windows/Octocode-0.1.0-windows-x64-setup.exe`
33. `Octocode-0.1.0-windows-x64-setup.exe /Q:A` 已完成静默安装到 `%LOCALAPPDATA%\Programs\Octocode\0.1.0`
34. 已安装版本 `app\octocode-cli.exe status`
35. 已安装版本 `app\octocode-cli.exe --json snapshot demo`
36. 已安装版本 `app\octocode-cli.exe serve 991 demo`
37. `http://127.0.0.1:991/api/state?session=demo` 已确认输出 `status` / `providerRoutes` / `commands` / `tools` / `eventFeed`
38. `http://127.0.0.1:991/api/events?session=demo` 已确认输出 `items`
39. `http://127.0.0.1:991/api/health` 已确认输出 `items`
40. 安装版 `/api/chat`、`/api/tool`、`/api/settings`、`/api/command` 均已完成真实 POST 验证
41. `http://127.0.0.1:991/ui-shell/?session=demo` 已确认输出 `sidebar-canvas` / `message-canvas` / `composer-canvas`
42. `powershell -ExecutionPolicy Bypass -File .\scripts\test-regression.ps1 -Port 991 -Session demo` 已完成 54/54 通过
43. slash-command `/snapshot` `/sessions` `/status` `/events` `/health` `/doctor` `/history` `/read` `/list` `/tool` `/plan` `/search` `/reload` 已完成真实 HTTP 回归
44. `octocode-cli --json snapshot demo` 在 provider health cache 生效后耗时已从约 24s 降到约 1.6s
45. `http://127.0.0.1:991/api/timeline?session=demo` 已确认输出 `items`
46. slash-command `pipe read README.md | list .` 已确认返回结构化 `steps` 数组
47. `cargo run -p octocode-cli -- mcp list` 已可枚举 `.octocode/mcp`、`mcp` 与 `config_home/mcp` 下的 MCP manifest
48. `cargo test -p octocode-mcp` 已覆盖 manifest 发现与生命周期状态迁移
49. `cargo run -p octocode-cli -- skills` 已可枚举 workspace 与 user scope 下的本地 skills
50. `cargo test --workspace` 已完成 20/20 通过，覆盖 `octocode_api`、`octocode_commands`、`octocode_mcp`、`octocode_plugins`、`octocode_runtime`、`octocode_skills`
51. `powershell -ExecutionPolicy Bypass -File .\scripts\test-regression.ps1 -Port 10023 -Session demo` 已完成 80/80 通过，确认 release WebUI + HTTP 回归在本轮改造后保持绿色

## 未完成

1. MCP process spawning / transport bridge / tool wiring
2. plugin / skills / hooks
3. full slash-command parity
4. Canvas UI 全量统一 runtime event bus
5. REPL 深化与多步命令组合仍可继续扩展到更丰富的条件、分支与 agent/workflow 协调
6. 组件级输入命中测试仍未覆盖到设置表单等 DOM 区域
7. VS Code / Cline / Cursor integration layer
8. skills / plugins / hooks / MCP transport execution
9. 本地模型与闭源模型完整接入与 provider failover
10. macOS 原生安装验收
11. Linux 原生安装验收与桌面入口验收

## 当前里程碑定位

当前仓库已经从“静态 shell + 伪 provider”推进到“可编译、可运行、具显式 provider routing、具 runtime snapshot/route/event surface、具交互式本地 backend、具工作流恢复语义的 runtime/workbench 阶段”。

## 当前同步状态

1. `origin/master` 已同步到 `0351240`，运行时统一 surface、多平台打包链路与 54/54 回归基线已推送到远端
2. 当前工作树正在追加 settings/tool 面板继续收口、`pipe` 多步命令与 workflow timeline 可观测性增强

## 下一阶段优先级

1. 把 runtime router 的 route policy、优先级与 fallback 理由继续显式化并持久化
2. 把剩余 Canvas UI 区域继续改成只消费统一 runtime snapshot/event，而不是自行回推业务逻辑
3. 扩充 command surface 到更多 CLI parity 命令与 richer snapshot/event export
4. REPL 与 conversation runtime 深化
5. 在原生 macOS / Linux 主机上完成安装器验收与 smoke test
6. MCP / tools / plugin parity
7. 基于四个参考仓库的重构切片已启动，当前第一批优先落地 MCP / 多 agent / 工具扩展骨架
8. 第二个增量切片已落地到 skills discovery，后续进入 task / coordinator 骨架
7. 从当前 Wry 桌面壳推进到发行版打包与自更新链路

## 当前风险说明

1. 用户指定模型端点 `http://192.168.110.2:8000/v1` 已经完成过 `/v1/models` 与一次 `/v1/chat/completions` 成功探测。
2. 本轮后续联调阶段，该端点出现了持续超时，因此当前交互式 chat API 会把 provider 错误写入 transcript，而不是返回模型内容。
3. 这说明 Octocode 的交互链路、错误恢复链路和 UI 展示链路已经工作；当前已具备熔断与自动恢复语义，但目标模型服务仍不稳定，后续仍需继续做 provider failover 观测增强或外部服务排障。

---

## Iteration 2026-04-17-B: Task Registry 切片（已完成）

### 验收结果

- cargo test --workspace: **23/23 passed** (+3 新 task 单元测试)
- WebUI regression: **88/88 passed** (80 → 88，新增 Section 20 task 端点测试)
- GET /api/tasks → {"items":[]}
- POST /api/tasks → {"id":"t-1","sessionId":"...","label":"...","state":"pending"}
- WebUI workflow tab 已增加 [tasks] 段落，异步刷新来自 /api/tasks

### 本轮新增文件

- crates/octocode-core/src/lib.rs: TaskKind, TaskState, TaskRecord 类型
- crates/octocode-runtime/src/tasks.rs: TaskStore (进程内 Mutex, 原子 id 计数器)
- docs/modules/task-registry-spec.md: 模块规范文档
- scripts/test-regression.ps1: Section 20 task 断言 (8 项)

### 本轮修改文件

- crates/octocode-runtime/src/lib.rs: TaskStore 字段, task_submit/list/get/finish 方法
- crates/octocode-cli/src/server.rs: GET /api/tasks, POST /api/tasks 路由
- ui-shell/app.js: renderWorkflowTab 增加 [tasks] 段，异步从 /api/tasks 刷新

---

## Iteration 2026-04-17-C: Tool Expansion（已完成）

### 验收结果

- cargo test --workspace: **23/23 passed**（无回归）
- WebUI regression: **93/93 passed**（88 → 93，+5 新工具目录断言）
- GET /api/state → tools.Count = 20 ✓
- 5 个新工具名全部在 catalog 中可见 ✓

### 本轮新增文件

- docs/modules/tool-expansion-spec.md: 模块规范文档

### 本轮修改文件

- crates/octocode-runtime/src/tools.rs:
  - TOOLS const 新增 5 个 ToolDescriptor（create-file, delete-file, move-file, task-submit, task-list）
  - security_check_path 方法（canonicalize + starts_with workspace root 防止路径越界）
  - execute() 新增 5 个 match arm（create-file/delete-file/move-file 执行真实 fs 操作，带越界防护；task-submit/task-list 为占位输出，指向 /api/tasks）
- scripts/test-regression.ps1: tools.Count 断言升为 >= 20，新增 5 个工具名检查

---

## Iteration 2026-04-17-D: Permission Refinement（已完成）

### 验收结果

- cargo test --workspace: **29/29 passed**（+6：2 个 deny-list 单测 + 4 个 api 单测纳入 workspace 运行）
- WebUI regression: **99/99 passed**（93 → 99，+6 permission deny-list 断言）
- GET /api/state → deniedTools: [] ✓（字段类型 Object[]）
- denyTool=echo → deniedTools 包含 echo → tool call 返回 HTTP 500 ✓
- allowTool=echo → deniedTools 清空 → tool call 恢复正常 ✓

### 本轮新增文件

- docs/modules/permission-refinement-spec.md: 模块规范文档

### 本轮修改文件

- crates/octocode-core/src/lib.rs: RuntimeConfig 新增 `denied_tools: Vec<String>` 字段
- crates/octocode-runtime/src/lib.rs:
  - default_config()：denied_tools: Vec::new()
  - load()：解析 denied_tools=tool1,tool2（逗号分割）
  - save()：写入 denied_tools={joined} 行
  - ensure_permission()：在 rank 检查之前优先检查 denied_tools
  - snapshot JSON：新增 deniedTools 数组字段
  - 新增 2 个单测：denied_tools_blocks_specific_tool, denied_tools_allow_removes_entry
- crates/octocode-api/src/lib.rs: create_by_id() 和测试代码的 RuntimeConfig 初始化补齐 denied_tools 字段
- crates/octocode-runtime/src/router.rs: RuntimeConfig 初始化补齐 denied_tools 字段
- crates/octocode-cli/src/server.rs: POST /api/settings 新增 denyTool / allowTool 参数处理
- scripts/test-regression.ps1: 新增 Section 21（6 个断言）
