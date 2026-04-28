# Turn Lifecycle 收敛评估报告

生成日期：2026-04-22

## 背景

本轮工作承接前一阶段的会话收敛改造。目标不是继续扩功能面，而是验证并加固一个更明确的事实：turn lifecycle 由后端持久化与结算，前端只消费 `activeSession.turn` 这一份状态源。

本次用户选择的收尾项有三部分：

1. 为 `/api/state` 与 `/api/stream` 增加服务端回归覆盖。
2. 提升前端 turn lifecycle 可见性。
3. 结合此前对话，形成专项评估分析报告。

## 本次产出

### 1. 后端契约加固

在 [crates/octocode-cli/src/server.rs](crates/octocode-cli/src/server.rs) 中抽出了两个可注入 runtime 的服务端辅助函数：

- `snapshot_response_from_runtime(...)`
- `write_sse_stream_response(...)`

这样做的目的不是重构表面结构，而是把 `/api/state` 与 `/api/stream` 的响应生成逻辑从真实 HTTP 监听和真实 provider 依赖里剥离出来，便于做窄而稳定的端点级测试。

新增的端点回归测试覆盖了两个关键契约：

1. `/api/state` 必须返回完整的 `activeSession.turn` 生命周期结构。
2. `/api/stream` 在完成 SSE 输出后，必须能把 turn 持久化到终态，并输出 `[DONE]`。

对应测试位于 [crates/octocode-cli/src/server.rs](crates/octocode-cli/src/server.rs#L2392) 和 [crates/octocode-cli/src/server.rs](crates/octocode-cli/src/server.rs#L2412)。

### 2. 前端状态可见性提升

前端此前已经能消费 `activeSession.turn.phase`，但展示方式仍然比较隐蔽，只是混在 status 文本里，不利于用户快速判断当前 turn 是否在运行、已完成、失败还是处于流恢复阶段。

本轮把状态栏中的 turn 状态提升为独立状态项：

- DOM 节点位于 [ui-shell/index.html](ui-shell/index.html#L327)
- 生命周期描述逻辑位于 [ui-shell/app.js](ui-shell/app.js#L278)
- 状态栏渲染逻辑位于 [ui-shell/app.js](ui-shell/app.js#L829)

本次又进一步补齐了视觉语义，在 [ui-shell/app.css](ui-shell/app.css#L1331) 附近为 `status-turn` 增加了按 phase 着色的 badge 表现：

1. `idle` 为中性态。
2. `running` 为进行态。
3. `completed` 为成功态。
4. `failed` 为失败态。
5. `cancelled` 为取消态。
6. `interrupted` 为中断态。

这一步的价值是把“后端状态机已经存在”真正转化成“用户能稳定读到的操作反馈”。

## 验证结果

### 1. 窄回归

已通过新增的两个服务端测试：

1. `state_endpoint_response_includes_turn_lifecycle_contract`
2. `sse_stream_response_emits_done_and_persists_completed_turn`

### 2. 更宽回归

本轮会继续执行 `cargo test -p octocode-cli --bins`，用来验证新增 seam、端点测试和状态栏相关输出没有对 CLI 二进制层造成回归。

### 3. 真实 WebUI 校验

此前已经完成一轮真实服务校验，确认了：

1. 页面可在本地服务中正常打开。
2. `/api/state?session=demo` 能返回 live 的 `activeSession.turn`。
3. 服务端实际返回的页面 HTML 中包含 `id="status-turn"`。

本轮会再次做一次真实页面级验证，重点确认 turn badge 节点仍被服务端正确交付。

## 设计判断

### 已经解决的问题

1. turn lifecycle 的事实来源已从前端推断迁移到后端持久化状态。
2. `/api/state` 和 `/api/stream` 的核心契约已有明确回归保护。
3. SSE 中断、恢复与完成不再只能依赖即时流文本判断，前端可以通过 snapshot 读到后端终态。
4. 状态栏已经具备最小但清晰的生命周期可观测性。

### 仍然存在的边界

1. 当前前端可见性仍然停留在状态栏 badge 级别，没有扩展到消息流、事件时间线或详细 turn 诊断面板。
2. 真实浏览器校验目前主要验证“页面可达 + 节点已被服务端交付 + live API 正常”，对运行中 DOM 细节的自动化检查仍较浅。
3. 更大范围的跨 crate 回归仍应依赖完整 cargo 测试矩阵，而不是只依赖窄测试。

## 结论

这轮工作已经把之前的架构改造从“实现上可行”推进到“契约上可验证、界面上可见”。

如果用工程标准来评估，这次收尾的核心价值不在于新增更多功能，而在于完成了三件更重要的事：

1. 把 turn lifecycle 的后端单一真相源固定下来。
2. 用服务端测试锁住 `/api/state` 与 `/api/stream` 的生命周期契约。
3. 让前端用户能在第一眼看到 turn 当前所处的阶段，而不是从混杂文本里猜测。

就当前范围而言，这一阶段已经达到“可以继续在此基础上演进 UI 和恢复策略，而不需要再回头重做状态归属”的成熟度。