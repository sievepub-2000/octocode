# OctoCode 项目详细分析评估 & 下一步工作计划

> 生成时间: 2026-01-XX | 基于 Sprint 1-5 完成后 + WebUI 修复后的状态

---

## 一、当前项目状态

### 1.1 架构概览

| 维度 | 数据 |
|------|------|
| 语言 | Rust (edition 2021) |
| Crate 数量 | 9 个 |
| 工具数量 | 29 个内置工具 |
| 测试数量 | 110+ (75 单元 + 6 E2E) |
| Clippy 警告 | 0 |
| 提供者数量 | 5 (local-openai, remote-openai, ollama, linkmind, stub) |
| UI | CLI REPL + WebUI (HTTP server) + Desktop (Wry/Tao) |
| MCP | 基础发现层 (McpRegistry) |
| 会话存储 | 文件存储 + 内存存储 |

### 1.2 Crate 依赖图

```
octocode-core          ← 领域类型、错误、Trait 定义
├── octocode-api       ← Provider 注册表、HTTP 客户端、流式传输、熔断器
├── octocode-mcp       ← MCP 发现与注册
├── octocode-skills    ← 技能框架
├── octocode-plugins   ← 插件 Trait 与宿主
├── octocode-mock-provider ← 测试存根
└── octocode-runtime   ← 会话管理、工具执行、压缩、协调器、成本追踪
    └── octocode-commands ← CLI 命令解析、格式化输出
        └── octocode-cli ← HTTP 服务器、Desktop 应用、入口点
```

### 1.3 WebUI 服务器 (修复后)

| 端点 | 状态 | 说明 |
|------|------|------|
| `GET /` | ✅ 302 → `/ui-shell/` | 根重定向 |
| `GET /ui-shell/` | ✅ 200 | 静态文件服务 (CWD + exe-relative 回退) |
| `GET /api/health` | ✅ 200 | 健康检查 (3s 探测超时, 缓存) |
| `GET /api/state` | ✅ 200 | 运行时状态快照 |
| `GET /api/events` | ✅ 200 | 事件流 |
| `GET /api/tools` | ✅ 200 | 工具列表 |
| `GET /api/tasks` | ✅ 200 | 任务列表 |
| `POST /api/chat` | ✅ 200 | 聊天 (URL-encoded form) |
| `POST /api/tool` | ✅ 200 | 工具调用 |
| `POST /api/settings` | ✅ 200 | 设置更新 |
| `POST /api/command` | ✅ 200 | 斜杠命令 |
| `GET /api/stream` | ✅ SSE | 流式 Token |
| `GET /ws` | ✅ WebSocket | 双向通信 |

**本次修复内容:**
1. 接受的 TcpStream 显式设为阻塞模式 (解决 Windows 非阻塞继承)
2. 添加 30s 读取超时 (防止僵死连接阻塞 Worker)
3. 过滤噪音错误日志 (scanner/空连接不再打印 "server error")
4. 静态文件路径回退到 exe 所在目录
5. 健康探测使用独立的短超时 HTTP 客户端 (3s connect, 5s read)

---

## 二、与竞品对比分析

### 2.1 特性矩阵

| 特性 | OctoCode | Claude Code (官方) | Claude Code (源码) | Claw Code | Archon |
|------|----------|-------------------|-------------------|-----------|--------|
| **语言** | Rust | TS (闭源) | TS | Rust + Python | TS (Bun) |
| **多 Provider** | ✅ 5个 | ❌ 仅 Claude | ❌ 仅 Claude | ⚠️ 2个 | ✅ 20+ (Pi) |
| **CLI** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Web UI** | ✅ 静态 HTML | ❌ | ❌ | ❌ | ✅ React SPA |
| **Desktop 应用** | ✅ Wry/Tao | ❌ | ❌ | ❌ | ❌ |
| **MCP 支持** | ⚠️ 基础 | ✅ 完整 | ✅ 完整 (23 文件) | ✅ 6模块 | ✅ 每节点 |
| **工具数量** | 29 | 30+ | 40+ | 40 | 委托给 Provider |
| **工作流引擎** | ⚠️ 协调器 | ❌ | ⚠️ 协调器 | ❌ | ✅ YAML DAG |
| **聊天平台** | ❌ | ⚠️ GitHub | ❌ | ❌ | ✅ Slack/TG/Discord |
| **熔断器** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **成本追踪** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Git 集成** | ❌ | ✅ | ✅ | ✅ | ✅ worktree 隔离 |
| **结构化输出** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **会话压缩** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **插件系统** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Voice/Vim** | ❌ | ✅ | ✅ | ❌ | ❌ |

### 2.2 OctoCode 独有优势

1. **原生 Desktop 应用** — 唯一使用 Wry/Tao 的项目
2. **多 Provider 熔断器** — 自动故障切换链
3. **零依赖 WebUI** — 静态 HTML 直接嵌入 Rust 二进制
4. **纯 Rust 单二进制** — 无运行时依赖
5. **内存效率** — Rust 所有权模型,无 GC

### 2.3 OctoCode 主要差距

1. **Git 集成** — 无 worktree 隔离,无 branch 管理
2. **MCP 深度** — 只有发现层,无完整客户端生命周期
3. **工具数量** — 29 vs 40+ (缺少 bash 验证、notebook、LSP)
4. **工作流引擎** — 无 YAML DAG,仅有简单协调器
5. **聊天平台适配器** — 无 Slack/Telegram/Discord
6. **结构化输出** — 未支持
7. **Hook 系统** — 基础,非 PreToolUse/PostToolUse 模式

---

## 三、Archon 集成状态

已完成:
- ✅ Archon 仓库克隆到 `c:\Users\周浩\vscode-workspace\archon`
- ✅ 创建 `.archon/` 目录在 OctoCode 项目中
- ✅ 4 个自定义工作流:
  - `octocode-build-verify.yaml` — 构建验证流水线
  - `octocode-feature.yaml` — 功能开发工作流
  - `octocode-fix-issue.yaml` — 问题修复工作流
  - `octocode-add-tool.yaml` — 添加新工具工作流
- ✅ 项目配置文件 `.archon/config.md`

---

## 四、下一步工作计划

### Phase 1: 核心补全 (P0 — 建议优先)

| # | 任务 | 预期影响 | 涉及 Crate |
|---|------|---------|------------|
| 1 | **完善 MCP 客户端** — 实现 stdio/HTTP 传输、工具桥接、生命周期管理 | 可与外部 MCP 服务器通信 | `octocode-mcp` |
| 2 | **添加 Bash 验证** — 命令白名单/黑名单、危险命令检测 | 安全性提升 | `octocode-runtime` |
| 3 | **Git 上下文** — 自动检测 repo、branch、diff、status | 代码感知能力 | `octocode-runtime` |
| 4 | **结构化输出** — 支持 JSON schema 约束的输出 | 工具链集成 | `octocode-core`, `octocode-api` |
| 5 | **添加更多工具** — notebook-edit, web-fetch, web-search, agent-tool, repl | 工具数量 29→40 | `octocode-runtime` |

### Phase 2: 体验优化 (P1)

| # | 任务 | 预期影响 | 涉及 Crate |
|---|------|---------|------------|
| 6 | **Hook 系统** — PreToolUse/PostToolUse 钩子 | 可扩展性 | `octocode-runtime` |
| 7 | **WebUI 增强** — 工具调用可视化、Markdown 渲染优化、暗色主题 | 用户体验 | `ui-shell/` |
| 8 | **会话恢复** — 从文件恢复中断的会话 | 持久性 | `octocode-runtime` |
| 9 | **Provider 健康仪表盘** — WebUI 中展示熔断器状态、延迟图 | 可观测性 | `ui-shell/`, server |
| 10 | **Token 估算** — 请求前估算 token 消耗 | 成本控制 | `octocode-api` |

### Phase 3: 高级功能 (P2)

| # | 任务 | 预期影响 | 涉及 Crate |
|---|------|---------|------------|
| 11 | **YAML 工作流引擎** — 类似 Archon 的 DAG 执行器 (Rust 原生) | 自动化能力 | 新 crate `octocode-workflows` |
| 12 | **多 Agent 协调器** — 并行 agent 任务分发 | 效率提升 | `octocode-runtime` |
| 13 | **Anthropic Provider** — 支持 Claude API | 更多模型选择 | `octocode-api` |
| 14 | **远程会话** — SSH/HTTP 隧道 | 远程开发 | `octocode-cli` |
| 15 | **Plugin Marketplace** — 在线插件发现与安装 | 生态系统 | `octocode-plugins` |

### Phase 4: 平台化 (P3)

| # | 任务 | 预期影响 | 涉及 Crate |
|---|------|---------|------------|
| 16 | **Slack/Telegram 适配器** — 聊天平台集成 | 多入口 | 新 crate `octocode-adapters` |
| 17 | **CI/CD 集成** — GitHub Actions workflow | 自动化 | `.github/workflows/` |
| 18 | **数据库后端** — SQLite 替代文件存储 | 查询能力 | `octocode-runtime` |
| 19 | **编译二进制分发** — Homebrew/scoop/cargo-install | 分发 | 构建配置 |
| 20 | **文档站点** — mdBook 或 Zola 生成 | 社区化 | `docs/` |

---

## 五、推荐立即执行项

基于当前状态和影响/投入比:

1. **#1 MCP 客户端** — Archon/Claude Code 都已完整支持,这是最大差距
2. **#3 Git 上下文** — 编码 agent 必备能力
3. **#5 补充工具** — web-fetch 和 agent-tool 是高价值工具
4. **#7 WebUI 增强** — 静态 UI 已可用,小改进大回报

---

## 六、代码质量评估

| 指标 | 评分 | 说明 |
|------|------|------|
| 架构清晰度 | ⭐⭐⭐⭐ | 9 crate 分层清晰,依赖 DAG 无环 |
| 代码风格 | ⭐⭐⭐⭐⭐ | 0 clippy 警告,一致的命名风格 |
| 测试覆盖 | ⭐⭐⭐ | 110 测试合理但缺少集成测试 |
| 错误处理 | ⭐⭐⭐⭐ | 自定义 OctoError, 熔断器模式 |
| 安全性 | ⭐⭐⭐ | 路径遍历防护在位,但缺少 bash 验证 |
| 文档 | ⭐⭐ | 仅有 README,缺少 API 文档和用户指南 |
| 可扩展性 | ⭐⭐⭐⭐ | Plugin/Skill/Provider trait 可扩展 |
| 性能 | ⭐⭐⭐⭐⭐ | Rust 原生,8 worker 线程池,熔断缓存 |
