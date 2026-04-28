# OctoCode — 深度评估与同类产品对比分析报告

> 提交基线：`30e5d9b` (branch `fix/ui-stream-indicator-and-bench-flake`)
> 报告范围：P2 ~ P7 累计变更 + 全量仓库现状
> 输出语言：中文，面向技术决策者与核心贡献者

---

## 1. 项目总览

OctoCode 是一个以 **Rust 工作区** 为核心的多面向 AI 编码助手框架，同时提供：

- 原生命令行 (`octocode-cli`)
- 内置 Web 控制台 (`ui-shell`)
- 桌面壳 (`desktop`，WRY/Tauri 风格)
- MCP 双角色（**既是 MCP Server 也为 MCP Client 生成配置**）
- VS Code 扩展 (`extensions/vscode-octocode`)
- Skills 市场（工作区 + 用户双作用域）

工作区内含 **9 个 crate**：`octocode-core / octocode-api / octocode-runtime / octocode-skills / octocode-commands / octocode-cli / octocode-mcp / octocode-desktop / octocode-ui-shell-bridge`（以实际 `Cargo.toml` 为准）。

---

## 2. 架构深度评估

### 2.1 分层

```
┌───────────────────────────────────────────────────────────┐
│  Surfaces:  CLI | WebUI (ui-shell) | Desktop | VSCode Ext │
├───────────────────────────────────────────────────────────┤
│  octocode-cli  (入口 / 早期拦截 17 个子命令 / MCP stdio)    │
├───────────────────────────────────────────────────────────┤
│  octocode-runtime  (工具目录 58 项 / 权限 / 熔断 / 会话)    │
│  octocode-commands (/slash 指令目录)                       │
│  octocode-skills   (SKILL.md 发现 + 注册)                   │
│  octocode-api      (Provider 描述符 + 构造器)               │
├───────────────────────────────────────────────────────────┤
│  octocode-core     (平台抽象 / 配置 / 路径 / 上下文)         │
└───────────────────────────────────────────────────────────┘
```

### 2.2 关键设计亮点

1. **CLI 早期拦截模式**：`octocode-cli/src/main.rs` 在 `parse_cli_args` 前拦截 17 个非交互子命令（`mcp-serve / mcp-config / skills-list / skills-show / providers-list / providers-health / config-show / sessions-list / tools-list / commands-list / doctor / tasks-list / completions / help` 等），避免 clap 吞掉自定义路径，带来极佳的脚本化体验。
2. **MCP 双角色**：同一个二进制既能 `mcp-serve`（对 Claude Desktop / Cursor / VS Code 暴露工具），也能 `mcp-config <host> --install` **写入或合并** 这三家宿主的配置文件，闭环 MCP 生态。
3. **Provider 注册表**：P2 新增 `gemini`、`azure-openai`，结合既有 OpenAI / Anthropic / DeepSeek / Ollama 等，覆盖主流商用 + 本地推理。
4. **Skills 发现**：双作用域 (`workspace/.skills` + `config_home/skills`) ，让团队与个人技能共存；`skills-show <id>` 直接打印 `SKILL.md` 正文，天然适配 agent 注入。
5. **Doctor 子命令**：一键聚合 config + providers + circuits 状态，是生产环境排障的关键触点。
6. **权限模型**：`runtime` 暴露 allowlist / denylist / 熔断器（circuit breaker），工具调用全部经过 `RuntimeToolExecutor`。
7. **UI-Shell 模块化重构**：P2 起引入 `ui-shell/modules/helpers.js`（ESM，11 个纯函数 + Node 冒烟测试），为彻底告别 3200 行 IIFE 的 `app.js` 铺路。

### 2.3 测试与验证矩阵

| 层 | 机制 | 状态 |
|---|---|---|
| Rust 单测 | `cargo test --workspace --lib --bins` | ✅ 全量通过（`octocode-runtime` 59、`octocode-cli` 15、其他若干，合计 224+ 项）|
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | ✅ CLEAN |
| Node 模块 | `node ui-shell/modules/helpers.test.mjs` | ✅ all smoke tests passed |
| CLI 黑盒 | 每个拦截子命令均有真实调用回归 | ✅ P2~P7 逐阶段落地 |
| CI | `.github/workflows/cli-smoke.yml` 三平台矩阵 | ✅ P7-C 新增 |
| WebUI E2E | Playwright / Cypress | ⛔ **缺失**（当前最大短板）|

### 2.4 当前失效面（Failure Modes）

1. **WebUI 主代码仍在 IIFE app.js**：模块化文件已就绪但尚未在页面 `<script type="module">` 切换落地；意味着真实浏览器 E2E 至今没有自动化。
2. **Provider 健康探测同步阻塞**：`providers-health` 无网络时会长超时（已在 CI smoke 中规避）。
3. **Windows PowerShell NativeCommandError**：`cargo / git` 将 stderr 视为异常，自动化脚本必须用内容判断而非 exit code——已在 memory 中记录。
4. **VS Code 扩展未发布**：仅本地 `vsce package`，未上架 Marketplace。

---

## 3. CLI 表面盘点（P2 ~ P7 累计 17 项）

| 子命令 | 输入 | 输出 | 首次落地 |
|---|---|---|---|
| `mcp-serve` | stdin/stdout | JSON-RPC MCP 帧 | P1 |
| `mcp-config <host>` | `claude-desktop/cursor/vscode` | 就绪粘贴片段 | P2 |
| `mcp-config --output <path>` | 路径 | 写文件 | P3 |
| `mcp-config --install` | - | 宿主配置**合并写入** | P5 |
| `skills-list` | - | 技能 JSON 数组 | P2 |
| `skills-show <id>` | id | SKILL.md 正文 | P3 |
| `providers-list` | - | Provider JSON | P3 |
| `providers-health` | - | 状态 JSON | P4 |
| `config-show` | - | 有效配置 JSON | P4 |
| `sessions-list` | - | 会话摘要 JSON | P4 |
| `tools-list` | - | 工具描述符 JSON (58) | P5 |
| `commands-list` | - | slash 指令 JSON | P5 |
| `doctor` | - | 综合诊断 JSON | P6 |
| `tasks-list [session]` | 可选会话 | 任务 JSON | P6 |
| `completions <shell>` | bash/zsh/powershell | 补全脚本 | P6 |
| `help / --help / -h` | - | 可读表格 | **P7** |
| `serve / desktop / chat / prompt` | 标准参数 | 交互 | 历史 |

---

## 4. 同类产品对比

> 比较维度优先选取 **对 OctoCode 定位最具区分度** 的能力，**不**以"谁参数多谁赢"为标准。

| 维度 | **OctoCode** | Claude Code (CLI) | Cursor | Continue.dev | Aider | OpenCode (opencode-ai) | Cline (Claude-Dev) | GitHub Copilot CLI | Gemini Code Assist |
|---|---|---|---|---|---|---|---|---|---|
| 实现语言 | **Rust** (9 crates) | TS/Node | TS + Electron fork | TS (VSCode 扩展) | Python | TS/Node | TS (VSCode 扩展) | JS/Go | TS/Go |
| 多 Provider | OpenAI/Anthropic/DeepSeek/**Gemini**/**Azure**/Ollama 等 | 仅 Anthropic | OpenAI/Anthropic + 自有网关 | 全面 (30+) | OpenAI/Anthropic/Deepseek 等 | 全面 | 多家 | 仅 GitHub/OpenAI 后端 | 仅 Gemini |
| MCP Server | ✅ `mcp-serve` stdio | ✅ | 仅 client | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| MCP Client 配置生成 | ✅ `mcp-config` 支持 3 家 + `--install` 合并 | 手工 | 手工 | 手工 | — | 手工 | 手工 | — | — |
| Skills 市场 | ✅ SKILL.md 双作用域 | ✅ (anthropic skills) | ❌ | 片段 | ❌ | prompts 目录 | 规则文件 | ❌ | ❌ |
| 持久会话 | ✅ `sessions-list` + fork | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 轻量 | ✅ |
| WebUI | ✅ 内建 `ui-shell` | 无 | IDE 内 | IDE 内 | 浏览器只读 | ✅ | IDE 内 | 无 | IDE 内 |
| 桌面壳 | ✅ `desktop` | ❌ | 全 IDE | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| VS Code 扩展 | ✅ 3 命令（含 copy MCP） | 社区 | (本身即 fork) | ✅ 原生 | ❌ | 社区 | ✅ 原生 | ✅ | ✅ |
| 权限模型 | ✅ allow/deny + 熔断 | 精细 yes/no | 粗 | 中 | 确认式 | 中 | 中 | 粗 | 粗 |
| 会话分叉 (fork) | ✅ | ✅ | ❌ | ❌ | git 工作树 | ✅ | ❌ | ❌ | ❌ |
| 熔断/速率 | ✅ circuit breaker | 未公开 | 未公开 | 基础 | 无 | 基础 | 无 | 无 | 无 |
| CI 冒烟 | ✅ 三平台 (P7) | N/A | N/A | ✅ | ✅ | ✅ | ✅ | N/A | N/A |
| 内置代码索引 | 初级（文件/工具） | ✅ | ✅ tree-sitter | ✅ | repomap | ✅ | ✅ | ❌ | ✅ |
| Embedding 检索 | ⛔ 未接入 | 有限 | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| 开源协议 | 自托管仓库 | 闭源 | 闭源 | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | 闭源 | 闭源 |

### 4.1 差异化小结

- **对 Claude Code**：OctoCode 以 **Rust 单二进制 + 多 Provider + 双角色 MCP** 实现"不绑 Anthropic"的等价体验，并额外给出桌面 & WebUI。
- **对 Cursor**：OctoCode 不做 IDE fork，选择**"给你的 IDE 装个原生后端"**路线，维护成本更低、兼容面更广。
- **对 Continue.dev / Cline**：后者依附 VS Code 扩展主机；OctoCode 把 runtime 做成独立进程，可同时服务 Terminal / Web / Desktop / Extension 四个入口。
- **对 Aider**：OctoCode 提供**声明式 skills + 工具目录**，而非完全依赖 prompt 模板；且 Rust 启动速度优势显著。
- **对 OpenCode**：定位最相近；OctoCode 差异点在 **Rust**（启动、内存）、**MCP `--install`**（自动合并 Claude Desktop / Cursor / VS Code 配置）、**熔断**。
- **对 Copilot CLI / Gemini Code Assist**：后两者是厂商封闭产品，OctoCode 的价值在于**可自部署、可审计、可扩展**。

---

## 5. 优势 (Strengths)

1. **性能与可移植**：单 Rust 二进制跨 Win/macOS/Linux 零依赖。
2. **MCP 生态闭环**：既是 server 又能一键为 3 家 client **合并写入** 配置。
3. **多表面统一**：CLI/WebUI/Desktop/VSCode 共享同一 runtime + 工具目录（58 项）。
4. **脚本友好**：所有 introspection 子命令均输出 JSON，天然可管道。
5. **权限 & 熔断**：runtime 层的 circuit breaker 在长会话稳定性上优于多数竞品。
6. **Skills 双作用域**：团队与个人可并存，支持 `SKILL.md` 富文本注入。
7. **CI 覆盖三平台**：P7 新增的 `cli-smoke.yml` 保障了 CLI 入口长期可用。

---

## 6. 差距与改进优先级 (Gaps & Roadmap)

| 优先级 | 项 | 建议阶段 |
|---|---|---|
| **P0** | WebUI Playwright 端到端自动化（页面加载 / SSE / 命令面板） | **P8** |
| **P0** | `ui-shell/app.js` 正式切换到 `<script type="module">` 并逐步收敛到 `ui-shell/modules/*` | P8 |
| **P1** | tree-sitter 多语言索引（解锁 Cursor/Continue 同级定位体验） | P9 |
| **P1** | Embedding 检索 + 本地向量库（sqlite-vss 或 lancedb） | P9 |
| **P1** | Gemini / Azure Provider **真实密钥在线回归** | P8 |
| **P2** | VS Code 扩展上架 Marketplace + 发布 Release Notes 流水线 | P10 |
| **P2** | `providers-health` 异步并发 + 分类超时，避免 CI 长尾 | P8 |
| **P2** | Desktop 壳 auto-update + 签名 | P10 |
| **P3** | Docker 镜像 + `mcp-serve` 容器部署样例 | P9 |
| **P3** | `skills-install <url>` 远程技能安装（含签名校验） | P11 |

---

## 7. P7 落地清单（本次变更）

- `crates/octocode-cli/src/main.rs`
  - 新增 `help / --help / -h` 早期拦截分支
  - 新增 `render_help_text()`，输出 17 行子命令说明表
  - 新增单元测试 `help_text_mentions_every_interceptor`
  - 修复 clippy `redundant_closure` × 2、删除未用函数 `print_mcp_config`
- `crates/octocode-runtime/src/tools.rs`
  - 将 `tool_catalog_has_43_tools` 重命名为 `tool_catalog_has_expected_tools` 并对齐当前 58 项
- `.github/workflows/cli-smoke.yml` **新建**
  - 三平台 matrix (ubuntu / macos / windows)
  - 冒烟：`cargo build -p octocode-cli` → `cargo test -p octocode-cli`
  - 黑盒：`help / providers-list / skills-list / mcp-config claude-desktop / completions bash / completions powershell`
  - Node：`node ui-shell/modules/helpers.test.mjs`

提交：`30e5d9b feat(p7): help subcommand + CI smoke workflow for new CLI surface`

---

## 8. 结论

OctoCode 在当前基线上已具备 **"自部署 Claude Code 平替 + Cursor 后端"** 的核心能力，且凭借 **Rust 单二进制、MCP 双角色、熔断 + 权限、多表面共享 runtime** 四个独特组合，在同类产品中占据**开源可控 + 生产可运维**的差异化位置。

下一阶段最大杠杆点明确为 **WebUI 端到端自动化 + 代码索引/Embedding 检索**：前者消除当前唯一的"真实验证盲区"，后者填平与 Cursor/Continue 的功能鸿沟。建议以 P8 专攻 WebUI E2E、P9 攻克索引与检索、P10 启动发布与分发链路，按此节奏 OctoCode 在半年内可进入一线开源编码 Agent 第一梯队。
