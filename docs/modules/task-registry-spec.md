# Task Registry Module Spec

> autoresearch Iteration 2026-04-17-B

## 1. 目标

把 Octocode 从"每次 agent 调用都是无状态单次火箭"升级为能够持有和可观测的任务状态，
向 Claude Code / ClawCode 对齐，同时在 UI、HTTP、CLI 三个表面统一可见。

## 2. 当前基线

- `CliCommand::Agent` 和 `CliCommand::Workflow` 都是**无状态调用**：执行后只在 session 里留消息，
  没有任何可查询的 task id、状态、进度。
- WebUI 的 workflow tab 只渲染 event feed，没有任何 task 列表。

## 3. 约束

- 不引入新 crate；task store 作为进程内内存结构挂在 runtime 上。
- 不需要跨进程持久化（第一轮），TaskRecord 随服务重启清空。
- `UiSnapshot` 不增加字段（防止回归断点），tasks 走独立端点 `/api/tasks`。
- 所有 task id 由 caller 传入或由 runtime 自动生成（短 uuid 格式 `t-{n}`）。

## 4. 新类型（octocode-core/src/lib.rs）

```rust
pub enum TaskKind { Workflow, Agent, Tool }
pub enum TaskState { Pending, Running, Done, Failed }
pub struct TaskRecord {
    pub id: String,
    pub kind: TaskKind,
    pub session_id: String,
    pub label: String,
    pub state: TaskState,
    pub created_at_ms: u128,
    pub finished_at_ms: Option<u128>,
    pub result_summary: Option<String>,
}
```

## 5. TaskStore（runtime 进程内）

```rust
// 挂在 OctocodeRuntime 上
pub fn task_submit(kind, session_id, label) -> TaskRecord
pub fn task_list(session_id: Option<&str>) -> Vec<TaskRecord>
pub fn task_get(id: &str) -> Option<TaskRecord>
pub fn task_finish(id: &str, state: TaskState, summary: Option<String>)
```

## 6. HTTP 端点（octocode-cli/src/server.rs）

```
GET  /api/tasks?session={session_id}  → {items: [TaskRecord]}
POST /api/tasks                       → submit, returns TaskRecord
```

## 7. CLI 面（octocode-commands/src/lib.rs）

```
octocode-cli tasks             # list all tasks
octocode-cli tasks list        # same
```

REPL slash-command: `/tasks`

## 8. WebUI workflow tab（ui-shell/app.js）

在 renderWorkflowTab 里，如果 state 携带 tasks 字段，渲染 `[tasks]` 小节，
否则静默跳过。任务列表从独立的 `/api/tasks?session=` 加载，每次刷新。

## 9. 正确性验收

- `cargo test --workspace` 全量通过
- `/api/tasks` 返回 `{items:[...]}`
- POST `/api/tasks` 后，GET 可以看到对应记录
- 回归脚本 `scripts/test-regression.ps1` 新增任务 section（80+ → 88+ passing）
- WebUI workflow tab 有 tasks 小节

## 10. 性能门槛

- `task_list` 与 `task_get` 在 < 5000 tasks 规模下不可见延迟（内存操作）
- `/api/tasks` 非 provider 路径，< 50ms 响应时间
