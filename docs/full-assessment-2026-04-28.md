# Octocode 全量评估分析报告 — 2026-04-28

> 范围：本地工作区（`c:\Users\周浩\vscode-workspace\octocode`） vs GitHub 远程 (`origin/master` = `3afa438`) vs `docs/` 规划与参考项目（Claude Code / Clawcode）。
> 验证主机：Windows · PowerShell 5.1 · Rust 1.92.0。

---

## 0. 执行摘要

| 维度 | 结果 |
|---|---|
| 当前分支 | `fix/ui-stream-indicator-and-bench-flake` @ `2cad4dd` |
| 本地 master | `1890089`（v0.8 wabi-sabi WebUI） |
| GitHub `origin/master` | `3afa438`（Iteration 2: Plugin discovery, session fork, token tracking） |
| `HEAD` 领先 `origin/master` | **39 commits** |
| `origin/master` 领先 `HEAD` | 0 commits |
| `cargo check --workspace` | ✅ 0 error / 0 warning（dev profile finish in ~16s after fresh check） |
| Workspace 规模 | 9 crates · 43 Rust 源文件 · 26.6k LOC |
| 工具注册表 | **67 个内建工具** （`crates/octocode-runtime/src/tools.rs`） |
| Provider 注册表 | **17 个** (`docs/architecture.md` 与代码一致) |
| 测试历史快照 | 252→264→336+ 通过 / 0 失败（按 `docs/current-state-2026-04-22.md` / `final-assessment-2026.4.24.md`） |
| Skill 资源目录 | `skills/` 下 **36 个子目录** |
| Live regression 历史 | 33 → 54 → 65 → **74 断言**全通过（最近一轮） |
| 与上游同步状态 | **本地领先 39 提交，GitHub 未同步**（远程 `origin/master` 落后于本地分支与本地 master） |

**结论**：项目处于 **release-ready 但未推送** 状态。代码层面已落地了 `docs/` 中规划的 P0–P2 主体（多 provider、tool guards、memory v2、metrics、agent 监督、live regression），但远程仓库严重滞后，docs 间存在版本号/工具数互相打架的旧快照。

---

## 1. 本地工作区 vs GitHub 远程仓库

### 1.1 引用比对

```
HEAD(local)         2cad4dd  feat(agent): playbooks, wttr pre-approval, data-tool preview caps
origin/master       3afa438  Iteration 2: Plugin discovery, session fork, token tracking
local master        1890089  v0.8: Wabi-sabi WebUI redesign, 252 tests passing, 0 warnings
```

依据 `CLAUDE.md` 中“GitHub Update Strategy”规则：
1. `git rev-parse HEAD` ≠ `git rev-parse origin/master`，因此 GitHub **不能视为已同步**。
2. 最后一次确认到达 GitHub 的提交是 `45549b6`（更新换为 `3afa438` 在 `origin/master` 上后，需要再次校验，但当前 working tree 在 `fix/...` 分支，未 push）。
3. 当前应报告为 **local committed, remote not synced**。

### 1.2 39 个未推送提交（按主题分组）

| 分组 | 关键提交 |
|---|---|
| Provider 矩阵扩张 | `de3e8f7` 7 个主流厂商 + `openai-completion`；版本升至 `2026.4.24` |
| 工具注册表扩张 | `c008678` empty-recycle-bin；`3725ca9` 8 新工具（read-file-lines、multi-edit、get-errors、git-commit、git-branch、fetch-readable、html-to-markdown、run-task）；`1bdb16a` 全 59-tool 注册表注入 text-parser；当前 67-tool |
| Live regression | `82f83cc`、`fc4af22` 真实 WebUI 链路 → 59-tool 注册表 + CLI parity |
| Memory / Agent | `2fd9e59` memory v2 多级 scope + BM25-lite 搜索；`1930e1a` permanent memory + agent supervision；`dd2beaa` Prometheus 指标 |
| Metrics & 安全 | `e6e8c0b` skills-install HTTPS allowlist + Dockerfile + `/metrics` |
| 提示词 & Web 搜索 | `eadd3f4` 多引擎搜索回退 + CAPTCHA 检测；`313771f` Claude Code 风格 sectioned system prompt |
| 修复 | `bce5c0c` 静态资源 lossy UTF-8；`350f603` tool-/call- 前缀容忍 |

### 1.3 工作区干净度

`git status --porcelain` 仅 1 个未跟踪条目：
- `??  .srv.err` （服务运行临时文件，应进 `.gitignore`）

无修改未提交文件。

### 1.4 风险

1. 39 提交集中包含 provider 接入、工具/记忆/指标三个独立边界，与 `CLAUDE.md` "一次只跨一个 runtime boundary" 的提交规则不一致 —— 这些是**历史已发生的提交**，不可逆。
2. 多个 `target-live-*` / `target-livecheck-*` 目录在仓库根，旧文档已标注 Low risk。
3. 未提供 GitHub push 的网络验证；按 `CLAUDE.md` 规范应在推送后用 `git rev-parse HEAD` 对齐 `origin/master` 后才能宣称成功。

---

## 2. 工程结构（深度）

### 2.1 Cargo workspace 拓扑

| Crate | 文件 | LOC | 内部依赖 |
|---|---:|---:|---|
| `octocode-core` | 1 | 810 | — |
| `octocode-skills` | 1 | 125 | core |
| `octocode-plugins` | 3 | 991 | core |
| `octocode-mcp` | 2 | 1 040 | core |
| `octocode-mock-provider` | 1 | 277 | core |
| `octocode-api` | 1 | 2 079 | core |
| `octocode-runtime` | 23 | **12 708** | core, mcp, plugins, skills |
| `octocode-commands` | 1 | 1 322 | core, runtime |
| `octocode-cli` | 10 | 7 303 | api, commands, core, mcp, runtime, skills |

依赖图严格 DAG，与 `docs/architecture.md` §1 描述一致。

### 2.2 Runtime 子模块（23 个文件）

`benchmarks · compaction · config · coordinator · cost_tracker · file_guard · health_guardian · hooks · isolation · memory · permission · permission_rules · plan_mode · router · session · snapshot_json · sqlite_store · subagent · tasks · todo_store · tools · tool_call_parser` + `lib`

- `coordinator.rs / subagent.rs / tasks.rs / todo_store.rs` 表明 **多 agent / 子 agent / 任务生命周期** 已落地（曾在 `improvement-plan.md` 列为 P0/P1）。
- `file_guard.rs / permission_rules.rs / isolation.rs` 表明 **文件操作 guards、声明式 permission rules、隔离** 已落地（P0）。
- `memory.rs / sqlite_store.rs / compaction.rs` 表明 **记忆与会话压缩** 已落地，`sqlite_store.rs` 提示已具备持久化能力（不再仅 file-backed）。
- `health_guardian.rs / cost_tracker.rs / benchmarks.rs` 提供运行期健康/成本/性能闭环。

### 2.3 CLI 子模块

`desktop · index · main · manage_config · server · skills_install · terminal · tls · tui · ws`

- `desktop.rs` 桌面壳（tao + wry）
- `server.rs` HTTP + 静态 WebUI
- `terminal.rs` Windows PTY
- `tls.rs` 表明已具备本地 TLS 能力
- `tui.rs` REPL/TUI
- `ws.rs` WebSocket
- `skills_install.rs` HTTPS allowlist 安装器
- `tui` + `terminal` 的存在说明 CLI 不是单一 server，而是 CLI/TUI/Server/Desktop 4 个面共用的入口

### 2.4 构建状态（本次 fresh run）

```
$env:CARGO_HOME='...\.cargo'; cargo check --workspace
> exit=0; warnings/errors = 0
```

满足 `CLAUDE.md` 的 "release 前再次跑 cargo check" 门控的第一项。**未运行**：`cargo clippy -D warnings`、`cargo test --workspace`、`scripts/live-regression.mjs`。这些是历史快照中已验证（Clippy 0、test 336+、live 74/74），但本次会话未重跑。

---

## 3. docs/ 规划 vs 实际代码

`docs/` 共 27 个 Markdown，内容横跨 P0 计划、迭代报告、跨项目对比、当前状态快照。**这些文档之间存在数字打架**：

| 主题 | 早期文档值 | 中期 | 最新 |
|---|---|---|---|
| 工具数 | 29（README）／34（cross-project） | 59（final-assessment） | **67（代码实测）** |
| Provider | 8 | 17（architecture） | 17（一致） |
| 测试数 | 75 | 252 / 264 | 336+ |
| Live 断言 | 33 | 54 / 65 | 74 |
| 版本 | `0.1.0` | `2026.4.24` | `2026.4.24`（Cargo.toml 一致） |

### 3.1 已落地（与 `improvement-plan.md` / `clawcode-to-octocode-mapping.md` 对应）

| 计划项 | 计划文档 | 代码证据 | 状态 |
|---|---|---|---|
| Multi-Agent Coordinator | improvement-plan P0 #1 | `runtime/coordinator.rs` + `subagent.rs` + `team-create/list/delete/status` 工具 | ✅ |
| File Operation Guards | improvement-plan P0 #2 | `runtime/file_guard.rs` | ✅ |
| Mock LLM Service | improvement-plan P0 #3 | `crates/octocode-mock-provider`（277 LOC） | ✅ |
| LSP Tool | improvement-plan P1 #4 | `lsp-hover` 工具描述符 | 🟡（仅 hover，未覆盖 diagnostics/refs） |
| Web Search | improvement-plan P1 #5 | `web-search` + `eadd3f4` 多引擎回退 | ✅ |
| Task Lifecycle 扩展 | improvement-plan P1 #6 | `task-submit/list/get` 工具 + `runtime/tasks.rs` | 🟡（缺 stop/output） |
| Persistent Todo | improvement-plan P1 #7 | `todo-add/list/done` + `runtime/todo_store.rs` | ✅ |
| Notebook Edit | cross-project gap | `notebook-edit` 工具 | ✅（描述符） |
| Path 安全白名单 | NEXT_STEPS S1.1 | `runtime/file_guard.rs` + `permission_rules.rs` | ✅ |
| Clippy 清零 | NEXT_STEPS S1.2 | `current-state-2026-04-22.md` 记录 0 warning | ✅ |
| README | NEXT_STEPS S2.1 | `README.md` 已含快速开始/架构图/provider 表 | ✅ |
| LinkMind 集成文档 | NEXT_STEPS S2.3 | `docs/linkmind-integration.md` 存在 | ✅ |
| 优雅关闭 | NEXT_STEPS S3.1 | `cli/main.rs` ctrlc 依赖 + crate 依赖 | 🟡（依赖在，未深审） |
| Plugin 发现/热载 | clawcode-mapping 第一批 | `crates/octocode-plugins/discovery.rs + marketplace.rs` | ✅ |
| Provider 矩阵 | architecture §3 | 17 个 provider id（含 xai/openrouter/qwen/glm/kimi/xiaomi/minimax/openai-completion） | ✅ |
| 监督指标 | final-assessment §1B | 5 个 Prometheus counter/gauge（chat/tool/sessions/memory/agent） | ✅ |
| 内存 v2 | 提交 `2fd9e59` | `runtime/memory.rs` + BM25-lite + scope/tags/importance | ✅ |
| Skills HTTPS allowlist 安装 | 提交 `e6e8c0b` | `cli/skills_install.rs` | ✅ |
| MCP stdio | improvement-plan P0/P3 + commit `bb1340c` | `crates/octocode-mcp/{lib,server}.rs`（1040 LOC） | ✅ |
| 桌面打包（Win/macOS/Linux） | clawcode-mapping 第三/四批 | `scripts/package-{windows-installer.ps1,macos-installer.sh,linux-installer.sh}` | ✅（脚本齐全） |

### 3.2 显式 TODO / Known Limitations（来源 `final-assessment-2026.4.24.md` §4）

1. `openai-completion` 仍走 chat-completions 客户端，缺独立 `LegacyCompletionProvider`。
2. `agent_tasks` 进程内注册表，重启丢失。
3. memory store 未加密。
4. Linux 跨平台仅编译时验证，未进 CI。
5. Unwrap 审计未批量重构。

### 3.3 文档治理建议

- `current-state-2026-04-22.md` 与 `final-assessment-2026.4.24.md` 应共存为 **历史快照**，并在 `docs/README.md`（缺）或 `analysis-and-roadmap.md` 中明确标注 single source of truth。
- `README.md` 工具数仍写 **29**，应更新为 **67**；provider 表只列 5 个，应同步到 17 个或链接到 `docs/architecture.md`。

---

## 4. 与参考项目（Claude Code / Clawcode）对比

依据 `docs/cross-project-comparison.md` 的初版数据，叠加本次代码实测：

| 维度 | OctoCode（当前） | Claude-code-3 | Clawcode | OctoCode 相对状态 |
|---|---|---|---|---|
| 语言/工程 | Rust 9 crate / 26.6k LOC | TypeScript 单仓 | Python + Rust 9 crate / 48k LOC | 中等规模、强分层 |
| 工具总数 | **67** | 41+ | JSON 加载 | ✅ 已超越 Claude-3 数值 |
| Provider | 17 + circuit breaker + health TTL | 多 provider | bearer + proxy | ✅ 领先（独有 circuit breaker） |
| 多 agent | coordinator + subagent + team-* + agent-message | AgentTool / TeamCreate-Delete / coordinatorMode | OmX/clawhip/OmO 9-lane | ✅ **已闭合 P0 核心 gap**；clawcode 的 9-lane 并行未对齐 |
| Memory | memory v2（BM25-lite + scope/tags/importance）+ compaction + away_summary | memdir | 隐式 transcript | ✅ 领先于 claude-3 的 memdir |
| 文件 guard | file_guard.rs（binary、size、symlink） | LSP-aware | unshare + 容器 | ✅ 与 clawcode 持平、超过 claude-3 |
| Sandbox | permission mode + permission_rules + isolation.rs | 工具过滤 | unshare/容器 | 🟡（未做 unshare/容器） |
| MCP | 完整 stdio server + lifecycle | services/mcp | 有 | ✅ |
| Plugin | RuntimePlugin + discovery + marketplace + audit | plugin dirs | first-class | ✅ |
| Hooks | 5 类（SessionStart / Before-After Prompt / Before-After Tool） | 工具生态 | clawhip 事件 | 🟡 hook 类型仍少于 clawhip |
| Desktop UI | tao+wry+canvas WebUI（wabi-sabi） | Ink TUI | Discord-first | ✅ 桌面/WebUI 双栈，独有 |
| Metrics | 8 Prometheus counter/gauge | ❌ | ❌ | ✅ 独有 |
| 跨平台打包 | win IExpress / macOS pkg+dmg / linux tar | npm | python+rust | ✅ 桌面分发完整 |
| 测试体量 | 336+ unit + 74 live regression | — | parity harness | ✅ 体量充足 |

**结论**：OctoCode 在工具数、provider 数、metrics、桌面分发、memory 系统上**已超越 Claude-code-3 的可观测面**；但在 sandbox（unshare/容器）和 hook 事件粒度上仍落后 Clawcode。多 agent 9-lane 并行尚未实现（仅 team-create/list/delete + agent-message + coordinator 单层）。

---

## 5. 安全姿势（OWASP Top 10 摘要）

来源 `final-assessment-2026.4.24.md` §5，结合代码：

| 项 | 控制 | 位置 |
|---|---|---|
| A01 认证 | 每进程随机 32 B token，所有 `/api/*` 强制（除 `/api/health`、`/api/auth-token`） | `cli/server.rs::check_auth` |
| A02 凭据 | 环境变量注入；零硬编码 secret | `api/lib.rs::create_by_id_with_config` |
| A03 注入 | shell-out 工具按平台 escape；走 `enforce_approval` | `runtime/tools.rs` |
| A05 配置 | port 锁定 990–999 | `commands/lib.rs::is_allowed_web_port` |
| A09 日志 | `/metrics` 8 counter/gauge | `cli/server.rs` |
| A04 文件 | `file_guard.rs` 二进制/大小/symlink | `runtime/file_guard.rs` |

**未覆盖/弱**：A07 标识失效（无 token 轮换/过期）、A10 SSRF（http-get/web-browse/fetch-readable 未见域名 allowlist 白名单只在 skills-install 上启用）。

---

## 6. 验证矩阵（本次 + 历史）

| 检查 | 命令 | 历史结果 | 本次结果 |
|---|---|---|---|
| Workspace compile | `cargo check --workspace` | ok | ✅ ok（warnings=0, errors=0） |
| Lint 严格门 | `cargo clippy --workspace --all-targets -- -D warnings` | clean（4-22 / 4-24） | ⚪ 未在本次会话重跑 |
| Unit tests | `cargo test --workspace --no-fail-fast` | 336+ pass / 0 fail | ⚪ 未在本次会话重跑 |
| Live WebUI regression | `node scripts/live-regression.mjs 999 liveqa` | 74/74 PASS | ⚪ 未在本次会话重跑（建议 release 前再跑） |
| Provider catalog | `GET /api/manage/catalog` | 17 descriptors | ⚪ 未联机 |
| Tool inventory | `GET /api/tools` | 59 → 实测 67 | ⚪ 未联机；代码 67 |
| Metrics | `GET /metrics` | 8 系列 + build_info | ⚪ 未联机 |

⚪ = 因当前会话仅做静态评估，未启动 WebUI；按 `CLAUDE.md` 真实 WebUI smoke 应在推送/打包前再跑。

---

## 7. 风险与建议（按优先级）

### P0 — 阻塞 release / GitHub 同步
1. **推送同步**：`git push origin fix/ui-stream-indicator-and-bench-flake` 后再合并到 `master` 并 push；按 `CLAUDE.md` 用 `git rev-parse HEAD` 对齐 `origin/master` 才能宣称同步。
2. **README 同步**：工具数 29→67、provider 5→17（或改为链接到 architecture.md）。
3. **真实 WebUI smoke**：在干净终端跑一次 `start-webui.ps1 -Port 999 → /api/health → /api/tools → /metrics`，再正式宣布"release-ready"。

### P1 — 收敛 docs 与代码漂移
4. 在 `docs/` 顶部置入 `README.md`，标记单一权威：以 `final-assessment-2026.4.24.md` + 本报告为现状源；其它历史报告统一打"Historical"标签。
5. 实现 known-limitation §1：独立 `LegacyCompletionProvider` 真接 `/v1/completions`。
6. 持久化 `agent_tasks`（SQLite，复用 `runtime/sqlite_store.rs`）。
7. 补 unwrap 审计批次（hot path 替换为 `OctoError::Runtime`）。

### P2 — 能力扩展
8. SSRF 防护：`http-get / web-browse / fetch-readable / http-post` 增加可选 host allowlist 与私网/loopback 拒绝（默认 deny RFC1918 / metadata IP）。
9. Sandbox 升级：Linux 加 `unshare` 探测 + 容器 fallback（对齐 Clawcode）。
10. Hook 粒度：补 `BeforeCompaction / AfterAgentSpawn / OnError` 三类（对齐 cross-project 报告 §F）。
11. 9-lane 并行：将 `team-*` 工具升格为真正的并行执行器，而不仅是注册表。
12. Linux/macOS CI lane：在 GitHub Actions 跑 `live-regression.mjs`。

### P3 — 文档治理
13. 在 `docs/modules/` 下补每个 crate 的 1 页 module doc（边界 + 公共 API）。
14. 把 `target-live-*` 残留目录加入 `.gitignore` 并清理；`.srv.err` 同处理。

---

## 8. 总结

- **代码层面**：项目已超过 `improvement-plan.md` 中 P0 与多数 P1 的目标，工具数、provider 数、metrics、memory、agent 监督全部实装并有 live 验证；本次 `cargo check` 0 警 0 错。
- **协作层面**：本地领先 `origin/master` 39 提交，且 `master` 分支也未推送，**GitHub 仓库不能视为已同步**，按 `CLAUDE.md` 应明确标注 "local committed, remote not synced"。
- **文档层面**：`docs/` 多文件版本号不一致（工具 29/34/59/67、测试 75/252/264/336+），需要一次集中收敛。
- **下一步关键动作**：①推送对齐 GitHub；②README 数字同步；③release 前重新跑 clippy + test + live regression 三件套。
