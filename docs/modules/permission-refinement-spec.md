# 模块规范：Permission Refinement（权限精化）

**迭代编号:** Iteration D (2026-04-17-D)  
**Slice:** per-tool 拒绝追踪 + config 可覆盖工具白名单  
**假设:** 在 `RuntimeConfig` 中加入 `denied_tools: Vec<String>`，并在 `ensure_permission()` 中优先检查，即可实现运算符可审计、可动态撤销的工具级黑名单，使 Octocode 在权限可控性上超越 Claude Code（仅全局 permission_mode）。

---

## 当前状态

| 能力 | 现状 | 目标 |
|------|------|------|
| 全局权限模式 | ✅ ReadOnly / WorkspaceWrite / DangerFullAccess | 保持 |
| 工具级拒绝 | ❌ 无 | `denied_tools: Vec<String>` |
| 动态修改 | ❌ 仅能通过 permissionMode | POST /api/settings denyTool= / allowTool= |
| 可见性 | ❌ 快照不暴露 | config.deniedTools 在 JSON 快照可见 |
| 持久化 | N/A | 写入 octocode.conf |

---

## 设计决策

- `denied_tools` 存储在 `RuntimeConfig`，通过 `ConfigLoader.save()` 写入 `octocode.conf` 的 `denied_tools=tool1,tool2` 键
- `ensure_permission()` 优先检查 denied_tools（在全局 rank 检查之前）；被拒绝时返回 `OctoError::Runtime("permission denied for tool {name}: explicitly denied")`
- `/api/settings POST` 新增两个 form 字段：
  - `denyTool` — 将工具名加入 denied_tools（幂等）
  - `allowTool` — 将工具名从 denied_tools 移除（幂等）
- 快照 JSON config 段新增 `deniedTools` 数组字段
- 不引入新依赖，不改变其他测试行为

---

## 约束

- 工具名格式为 `kebab-case`，不含空格
- `denyTool` 操作不能使服务器本身无法响应（即不能 deny 非工具请求路径）
- 一次 POST /api/settings 最多添加一个 denyTool 和一个 allowTool
- 回归测试在 Section 21 结束时必须恢复 denied_tools 为空（不污染后续测试运行）

---

## 验收标准

1. POST /api/settings denyTool=echo → state.config.deniedTools 包含 "echo"
2. POST /api/tool echo（被 deny 后）→ HTTP 500，错误信息含 "permission denied"
3. POST /api/settings allowTool=echo → state.config.deniedTools 为空
4. POST /api/tool echo（restore 后）→ 正常快照响应
5. cargo test --workspace ≥ 23/23（+新增 1–2 个 deny 单元测试，目标 ≥ 25）
6. WebUI regression ≥ 93/93（+section 21 新断言，目标 ≥ 100）
