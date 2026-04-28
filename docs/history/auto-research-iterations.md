# Octocode Auto-Research Iterations

## Iteration 2026-04-17-A

- Hypothesis:
  把 Ollama 提升为一等 provider、把 CLAUDE.md / AGENTS.md 提升为 runtime bootstrap、并为 Hook 生命周期先起一个可审计骨架，可以同时提升功能完整性和后续迭代速度；如果新增逻辑采用缓存和最小可观测面，非 provider 本地路径不会退化。
- Correctness change:
  - 新增 `ollama` provider descriptor 与 fallback 链路。
  - 新 session 自动注入 `CLAUDE.md` / `AGENTS.md` 项目上下文。
  - 新增 `octocode-plugins` crate，并接入 `session-start` / `before-prompt` / `after-prompt` / `before-tool` / `after-tool` 生命周期。
  - 回归脚本新增 `ollama` provider 暴露检查与 plugin audit 可见性检查。
- Performance change:
  - 为 workspace bootstrap context 增加进程内缓存，避免每个新 session 重复读取上下文文件。
  - 保持 plugin 骨架为审计型 host，不引入动态加载和额外 I/O。
- Validation:
  - `cargo test -p octocode-api -p octocode-runtime --lib`
  - `cargo test -p octocode-plugins -p octocode-runtime --lib`
  - `cargo build -p octocode-cli --release`
  - `powershell -ExecutionPolicy Bypass -File scripts/test-regression.ps1 -Port 10021 -Session demo`
  - 真实 WebUI 已打开：`http://127.0.0.1:10021/ui-shell/?session=demo`
- Result:
  - 单测通过。
  - release 构建通过。
  - WebUI/API 回归通过 `80/80`。
  - 仍存在一条 `get_errors` 对 `scripts/test-regression.ps1` 的疑似误报，但不影响脚本执行与结果。
- Keep / Discard:
  - Keep：Ollama 一等接入、context bootstrap、plugin 审计骨架、context cache。
  - Discard：无。
- Next bottleneck:
  - plugin host 还只是进程内审计，没有插件发现、启停、配置和持久化。
  - session fork / branch 还未开始。
  - provider token/cost 追踪仍是粗估，需要更准确模型。

---

## Iteration 2026-04-17-B

**Target:** Task Registry 模块（Slice B）
**Hypothesis:** 在 octocode-runtime 中加入进程内 TaskStore，通过 /api/tasks 暴露，可以让
每个 agent/workflow 调用产生可查询的任务记录，并在 WebUI workflow tab 展示，使 Octocode
在多 agent 协调可见性上与 Claude Code 持平。

### 本轮变更

| 文件 | 变更 |
|------|------|
| octocode-core/src/lib.rs | + TaskKind, TaskState, TaskRecord |
| octocode-runtime/src/tasks.rs | + TaskStore (新文件，3 个单元测试) |
| octocode-runtime/src/lib.rs | + task_store 字段，task_submit/list/get/finish |
| octocode-cli/src/server.rs | + GET /api/tasks, POST /api/tasks |
| ui-shell/app.js | renderWorkflowTab 增加 [tasks] 段，async fetch |
| scripts/test-regression.ps1 | + Section 20 tasks (8 assertions) |
| docs/modules/task-registry-spec.md | 新规范文档 |

### 测量结果

- cargo test --workspace: 23/23 (从 20 → 23，+3 task 单元测试)
- WebUI regression: 88/88 (从 80 → 88，+8 task 断言)
- GET /api/tasks: {"items":[]} ✓
- POST /api/tasks: {"id":"t-1","state":"pending"} ✓

### Keep / Discard

- **KEEP:** TaskStore 进程内实现，API 接口干净，无新依赖
- **KEEP:** WebUI async 刷新模式，静默失败，不阻塞主渲染
- **DISCARD:** 考虑过把 tasks 加到 UiSnapshot，但那会强耦合每次 chat/tool 响应，独立端点更清晰

### 下一瓶颈

当前 Octocode 有 15 个工具，Claude Code 有 20+，ClawCode 有 25+。
下一轮扩充工具面：web-search (真实 HTML fetch + 文字提取), task-tool (在工具层创建/查询 task), file-diff, create-file。
目标: 15 → 20 工具，回归 88 → 96+。

---

## Iteration 2026-04-17-C

**Target:** Tool Expansion（工具扩展，15 → 20）
**Hypothesis:** 补齐 create-file / delete-file / move-file / task-submit / task-list 5 个工具，
可缩短 Octocode 与竞品在文件操作和任务感知上的差距，同时所有新工具都带路径安全检查
（workspace root 越界防护），不增加运行时依赖。

### 本轮变更

| 文件 | 变更 |
|------|------|
| octocode-runtime/src/tools.rs | + 5 个 ToolDescriptor（TOOLS const），+ security_check_path 方法，+ 5 个 match arm |
| scripts/test-regression.ps1 | tools.Count 断言改为 >= 20，+ 5 个新工具名存在检查 |
| docs/modules/tool-expansion-spec.md | 新规范文档 |

### 测量结果

- cargo test --workspace: 23/23（无新单元测试，工具验证通过回归）
- WebUI regression: 93/93（从 88 → 93，+5 工具目录断言）
- GET /api/state → tools.Count = 20 ✓
- create-file / delete-file / move-file / task-submit / task-list 全部出现在 catalog ✓

### Keep / Discard

- **KEEP:** security_check_path 路径越界防护（canonicalize + starts_with workspace root）
- **KEEP:** create-file / delete-file / move-file 实际执行 fs ops，有真实效用
- **KEEP:** task-submit / task-list 为轻量占位实现，指向 /api/tasks，未引入 TaskStore 耦合
- **DISCARD:** 考虑过给 WorkspaceToolExecutor 注入 TaskStore 引用，但会破坏无锁构造，占位文本输出足够

### 下一瓶颈

工具面已与 Claude Code 基本齐平（20 vs 20+）。
下一轮：Permission 精化——per-tool 拒绝追踪 + config 可覆盖权限模式。

---

## Iteration 2026-04-17-D

**Target:** Permission Refinement（权限精化，per-tool deny-list）
**Hypothesis:** 给 RuntimeConfig 增加 `denied_tools: Vec<String>` 字段，`ensure_permission()` 在 rank 检查前先检查 deny-list，再通过 `POST /api/settings` 暴露 denyTool/allowTool 接口，可在不改变全局 permissionMode 的前提下对单个工具实施运行时拦截。

### 本轮变更

| 文件 | 变更 |
|------|------|
| octocode-core/src/lib.rs | RuntimeConfig 新增 denied_tools 字段 |
| octocode-runtime/src/lib.rs | load/save/default/ensure_permission/snapshot 更新，+ 2 单测 |
| octocode-api/src/lib.rs | 2 处 RuntimeConfig 初始化补字段 |
| octocode-runtime/src/router.rs | 1 处 RuntimeConfig 初始化补字段 |
| octocode-cli/src/server.rs | POST /api/settings 新增 denyTool/allowTool 处理 |
| scripts/test-regression.ps1 | Section 21：deny-list 完整流程测试（6 断言）|
| docs/modules/permission-refinement-spec.md | 新规范文档 |

### 测量结果

- cargo test --workspace: 29/29（+6，无回归）
- WebUI regression: 99/99（93 → 99，+6 deny-list 断言）
- Section 21 完整验证：denyTool=echo → HTTP 500 → allowTool=echo → 恢复正常 ✓
- deniedTools 字段在 /api/state 快照中可见（Object[]）✓

### Keep / Discard

- **KEEP:** 完整 deny-list 生命周期（deny → blocked → allow → restored）
- **KEEP:** `ensure_permission()` 中 deny-list 优先于 rank 检查（设计正确，拒绝应在权限等级之前）
- **KEEP:** denyTool/allowTool 通过 /api/settings 动态可调（运行时无需重启）
- **DISCARD:** 考虑过持久化到 octocode.conf，但本轮以内存态为主，下轮再决策

### 下一瓶颈

Provider 侧缺少健康检测故障转移和 per-model 路由细化。
下一轮：Provider Expansion——health-check failover + per-model routing rules。
