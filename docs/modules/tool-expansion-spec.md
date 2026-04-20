# Tool Expansion Module Spec

> autoresearch Iteration 2026-04-17-C

## 1. 目标

从 15 工具扩充到 20 工具，在工具广度上向 Claude Code (20+) 和 ClawCode (25+) 对齐。

## 2. 当前基线

15 工具: echo, read-file, list-files, write-file, shell-command, search-text,
workflow-plan, agent-action, git-status, git-diff, git-log, file-tree,
append-file, http-get, read-context

## 3. 新增 5 个工具

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `create-file` | 创建新文件，若父目录不存在则自动创建 | WorkspaceWrite |
| `delete-file` | 删除工作区内文件 | WorkspaceWrite |
| `move-file` | 在工作区内移动或重命名文件 | WorkspaceWrite |
| `task-submit` | 向 TaskStore 提交任务记录 | ReadOnly |
| `task-list` | 列出当前 session 的任务 | ReadOnly |

## 4. 约束

- 不引入新依赖
- delete-file / move-file 需做路径安全检查（拒绝目标在工作区根以外）
- task-submit / task-list 通过 WorkspaceToolExecutor 调用 TaskStore
  → 但当前 WorkspaceToolExecutor 没有对 TaskStore 的引用
  → 解决方案: 通过工具 input JSON 的 session_id 字段触发 HTTP /api/tasks 自调用
    或者改为在 run_tool_in_session 中传递 task_store_ref
  → **简单路**: input 中直接处理，task-submit 写入 session 消息，task-list 从
    session 消息中提取（零依赖，self-contained）

## 5. 验收

- cargo test --workspace 全量通过（>=23）
- GET /api/state 中 tools.Count >= 20
- 回归脚本 tool 覆盖测试（88 → 93+）

## 6. 不在范围

- web-search（需要真实 HTTP 解析，留下一轮）
- file-diff（和 git-diff 重叠，留下一轮）
