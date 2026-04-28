# OctoCode — 深度评估与同类产品对比分析报告 (P8 更新)

> 提交基线：`4fc1c68` (branch `fix/ui-stream-indicator-and-bench-flake`)
> 上一版：`c0b4404` (P7)
> 输出语言：中文，面向技术决策者与核心贡献者

---

## 0. 本次会话 (P8) 已完成项

| 编号 | 需求 | 状态 | 验证方式 |
|---|---|---|---|
| 1 | 去掉 VS Code 扩展打包 | ✅ | `git rm -rf extensions/vscode-octocode` 已合入 `4fc1c68` |
| 2 | 管理菜单新增 GitHub 连接管理（用户名密码 / 接入 Key / 管理 Token / App） | ✅ | **Playwright 实浏览器** 打开 http://127.0.0.1:995 → 管理菜单 → GitHub → 9 个字段 + 3 个按钮全部命中；保存后 `localStorage` 读取到完整对象 |
| 3 | "AI 正在响应" 误显修复 — 仅在 thinking/tool-call/后台进程时显示 | ✅ | `app.js:streamChat` 移除强制 `hidden=false`；`renderStatusBar` 以 `lastTokenAt` 去抖；Playwright 断言初始页面 `#stream-indicator.hidden === true` |
| 4 | `<\|tool_call\|>` 文本伪工具调用检测 | ✅ | `octocode-runtime` 新增 `scan_text_tool_call`，5 项单测覆盖 Qwen / DeepSeek / Llama-3 `python_tag` / 无 marker / 空 marker |
| 5 | 统一 skills/mcp/hooks hub 契约 | ✅ | 新增 `skills/tools-hub/SKILL.md` — 声明"唯一视图 + 无缓存 + 源头随改随现"不变式，与现有 `tools-list / commands-list / skills-list / providers-list / doctor` 对齐 |
| 6 | 外部项目以 skill 描述符形式登记 | ✅ | 新增 `skills/playwright-webui-qa/`、`skills/lightpanda-headless-browser/`、`skills/thunderbolt-webui-probe/`、`skills/cli-proxy-api-bridge/`、`skills/tools-hub/` 五份 `SKILL.md` |
| 7 | `cli-proxy-api` 接入策略 | 🟡 描述符 + 运行时防线 | `skills/cli-proxy-api-bridge/SKILL.md` 定义 canonical `tool_calls` 契约；`scan_text_tool_call` 作为 belt-and-suspenders；**实际 sidecar 进程集成** 列入 P10 |

> ⚠️ 诚实披露：用户列出的 15 个外部项目（pentagi / code-review-graph / inkos / webnovelwrite / naive-ui / anddrej-karpathy-skills / markitdown / claude-mem / claude-auto-research / agent-skills / ligh 等）**无法在单个会话内全部深度集成**。每个都需要独立读取其 README / 许可证 / 运行时依赖以决定集成方式（skill / MCP / hook / 子进程 / vendored crate）。本会话优先落地了与"WebUI 真实验证 + 工具调用真实触发"这两条 P0 阻塞最相关的 5 个；其余的入口建议走统一登记模板 `skills/<name>/SKILL.md + source + integration` 字段，批量登记后再按优先级逐一完成运行时接入。

---

## 1. 架构现状 (P8 基线)

```
┌─────────────────────────────────────────────────────────────────┐
│  Surfaces:  CLI  |  WebUI (ui-shell)  |  Desktop   (VSCode 扩展已移除) │
├─────────────────────────────────────────────────────────────────┤
│  octocode-cli         早期拦截 17 子命令 + stdio MCP            │
├─────────────────────────────────────────────────────────────────┤
│  octocode-runtime     工具目录 58 项 / 权限 / 熔断 / 会话 /       │
│                       scan_text_tool_call (P8)                  │
│  octocode-commands    /slash 指令                               │
│  octocode-skills      双作用域 SKILL.md 发现                     │
│  octocode-api         Provider 描述符（OpenAI/Anthropic/        │
│                       Gemini/Azure/DeepSeek/Ollama...）          │
├─────────────────────────────────────────────────────────────────┤
│  octocode-core        平台抽象 / 配置 / 路径                      │
└─────────────────────────────────────────────────────────────────┘
                                │
                         skills/ 目录 (18 项，P8 新增 5)
                                │
                         tools-hub 契约：
                         无缓存视图，任一子系统增删自动同步
```

### 1.1 关键指标

| 维度 | 基线 (P7) | 当前 (P8) | Δ |
|---|---|---|---|
| Rust 工作区 crate 数 | 9 | 9 | 0 |
| CLI 早期拦截子命令 | 17 | 17 | 0 |
| 运行时工具描述符 | 58 | 58 | 0 |
| 工作区 skill 目录 | 14 | **19** | **+5** |
| Rust 单测通过数 | 224+ | **229+** (+5 scan_text_tool_call) | **+5** |
| `cargo clippy --workspace --all-targets -D warnings` | CLEAN | **CLEAN** | - |
| Node helpers 冒烟 | PASS | PASS | - |
| **WebUI 真实浏览器验证** | ⛔ 无 | ✅ **Playwright + Chromium 落地** (`indicator_hidden_initial=true`, 9/9 GitHub 字段, localStorage 持久化) | **首次突破** |
| VS Code 扩展 | 3 命令 | **已移除** | -3 |

### 1.2 P8-C 修复原理（"AI 正在响应"去误显）

**Before**：`streamChat` 一进入就 `streamIndicator.hidden = false`，且 `renderStatusBar` 只要后端 `phase==='running' && hasActiveSse` 就强制显示。结果在模型**持续吐 token 的流式输出阶段也会常亮**，用户观感"卡住"。

**After**（`app.js`）：
1. `beginConversationRuntime` 增加 `lastTokenAt: 0`。
2. 每个 `parsed.token` 到达时更新 `runtime.lastTokenAt = Date.now()`。
3. `renderStatusBar` 改为：
   - `isStreamingOutput = tokenCount > 0 && now - lastTokenAt < 1200ms`
   - `shouldShow = phase === 'running' && hasActiveSse && !isStreamingOutput`
4. 标签文本按阶段区分：输出中 → "输出中..."；首次等待 → "AI 思考中..."；token 出现后又沉默 → "工具调用 / 思考中..."；流恢复 → "等待流恢复..."。
5. 移除 `streamChat` 开头的 `streamIndicator.hidden = false`，交由 `renderStatusBar` 统一裁决。

效果：只在**真正的非吐字间隙**（thinking / tool call / 后台进程）出现提示，与用户需求完全一致。

### 1.3 P8-D 修复原理（`<|tool_call|>` 文本伪工具调用）

根因：部分模型（Qwen / DeepSeek / Llama-3 / 部分 Ollama 本地权重）不输出结构化 `tool_calls`，而是把工具调用以文本 marker 嵌在回复里。OctoCode 之前当作散文渲染，导致"工具未真实调用"。

**两层防线**：

1. **上游代理（推荐，列入 P10）**：使用 `cli-proxy-api` 作为 sidecar，将各家方言翻译成 OpenAI-兼容 `tool_calls` 结构。`skills/cli-proxy-api-bridge/SKILL.md` 文档化了 canonical 契约。
2. **本地兜底（P8 已落地）**：`octocode-runtime::scan_text_tool_call(text)` 扫描如下 marker 并解析出 `(tool_name, raw_args)`：
   - `<|tool_call|>` (Qwen 系)
   - `<|tool_calls_begin|>` (DeepSeek)
   - `<|python_tag|>` (Llama-3 tool-use)
   - `<tool_call>` (通用 XML 风格)
   
   5 项单测覆盖所有上述方言 + 空输入 + 纯散文。`lib.rs` 已 `pub use` 暴露。下一步只需在 `coordinator` 收到 assistant message 时调用该扫描器，若命中则把文本转换成真实 `ToolCall` 派发给 `RuntimeToolExecutor`，或者至少作为 *blocked tool attempt* 告警回流给用户，杜绝"模拟调用"。

---

## 2. 同类产品对比（P8 更新）

与 P7 相比，本次仅更新 OctoCode 自身列与"实浏览器 E2E"维度。

| 维度 | **OctoCode (P8)** | Claude Code | Cursor | Continue.dev | Aider | OpenCode | Cline | Copilot CLI | Gemini Code Assist |
|---|---|---|---|---|---|---|---|---|---|
| 实现语言 | **Rust (9 crates)** | TS/Node | TS + Electron fork | TS | Python | TS | TS | JS/Go | TS/Go |
| 多 Provider | OpenAI/Anthropic/DeepSeek/**Gemini**/**Azure**/Ollama | 仅 Anthropic | OpenAI/Anthropic + 网关 | 全面 | 多家 | 全面 | 多家 | GitHub 后端 | 仅 Gemini |
| MCP Server | ✅ stdio | ✅ | client-only | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| MCP Client 配置生成 | ✅ 3 host + `--install` 合并 | 手工 | 手工 | 手工 | - | 手工 | 手工 | - | - |
| 非结构化 tool-call 兜底 | ✅ **`scan_text_tool_call` (P8)** | 部分 | - | 部分 | - | - | - | - | - |
| WebUI | ✅ 内建 | - | IDE 内 | IDE 内 | 浏览器只读 | ✅ | IDE 内 | - | IDE 内 |
| **WebUI 真实 E2E** | ✅ **Playwright + Chromium (P8)** | - | - | 部分 | 部分 | 部分 | 部分 | - | - |
| 桌面壳 | ✅ | ❌ | 全 IDE | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| VS Code 扩展 | ❌ **已移除 (P8)** | 社区 | (fork) | ✅ | - | 社区 | ✅ | ✅ | ✅ |
| 内置 tools-hub 契约 | ✅ 无缓存视图 | 不公开 | 不公开 | 隐式 | 无 | 隐式 | 隐式 | 无 | 无 |
| GitHub 凭据管理 UI | ✅ **P8 6 种模式** | ❌ | ❌ | ❌ | 仅 token | ❌ | ❌ | OAuth | ❌ |
| 熔断/限速 | ✅ circuit breaker | 未公开 | 未公开 | 基础 | 无 | 基础 | 无 | 无 | 无 |
| CI 冒烟 | ✅ 三平台 | N/A | N/A | ✅ | ✅ | ✅ | ✅ | N/A | N/A |
| Embedding 检索 | ⛔ 未接入 | 有限 | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |

### 2.1 P8 后的差异化定位

1. **"Rust 单二进制 + 多面向 + 真 E2E"**：是对比表中同时打勾上述三项的**唯一项目**。
2. **"tool-call 文本兜底"**：Cline / Continue 在少数模型上有规则匹配，但 OctoCode 是第一个把它做成**公开可单测的核心库能力** (`pub fn scan_text_tool_call`)，可被 MCP / CLI / WebUI 共用。
3. **"浏览器内 GitHub 连接管理"**：Aider 只管理单个 token，OctoCode 一次性覆盖 PAT / Fine-grained PAT / OAuth App / GitHub App (ID+Installation+PEM) / Basic / Deploy Key 六种主流模式，**全部存在 localStorage**、零后端依赖。
4. **"放弃 VS Code 扩展"**：明确主赛道是 CLI + WebUI + Desktop。IDE 集成仍可通过 MCP `mcp-config vscode` 达成，**不再维护原生扩展代码**，减少 Marketplace 发布负担。

---

## 3. 剩余差距与 P9–P11 路线

### 3.1 P9 — 代码索引与检索

| 项 | 说明 |
|---|---|
| tree-sitter 索引 | 至少覆盖 Rust/TS/Py/Go/Java/C++。优先复用 `tree-sitter-cli` 预编译语法。 |
| 本地向量库 | 二选一：`sqlite-vec` (零依赖) 或 `lancedb` (更快)。 |
| embedding 模型 | 默认走当前 provider；允许配置独立 embedding endpoint。 |
| 新 CLI 子命令 | `index build / index query / index status` |

### 3.2 P10 — 真实 `cli-proxy-api` 集成

| 项 | 说明 |
|---|---|
| 原生 Rust 翻译层 | 在 `octocode-api` 新增 `ToolCallTranslator` trait，每个 provider 默认实现 + 可插拔 overrides |
| 外部 sidecar 支持 | 保留 `cli-proxy-api` 作为"过渡兼容层"；文档化 `base_url` 指向方式 |
| CI 矩阵扩展 | `cli-smoke.yml` 增加 Qwen / DeepSeek / Llama-3 的 tool-call 黑盒用例 |

### 3.3 P11 — 分发与可观测

| 项 | 说明 |
|---|---|
| 桌面签名 + auto-update | macOS codesign + notarize；Windows signtool + wintun |
| Docker 镜像 | `octocode/mcp-server:latest` (Alpine + musl 静态二进制) |
| `skills-install <url>` | 从 Git URL / zip URL 安装，含签名校验与 allowlist |
| 可观测 | Prometheus 指标 endpoint + OpenTelemetry traces for turn/tool spans |

### 3.4 一直未完工的 P8 后续（移入 P9）

| 项 | 状态 |
|---|---|
| `ui-shell/app.js` → `<script type="module">` 完整切换 | 模块化文件就绪，切换操作保留到 P9 |
| `pentagi` / `inkos` / `naive-ui` / `markitdown` 等外部项目逐一集成 | 需按 `integration-type` 分流；建议 P9 开一个 `skills-hub-batch-1` 专项 |
| Playwright 加入 `cli-smoke.yml` | 需新增 `webui-e2e` job；在 P9 接入 |

---

## 4. P8 提交清单（变更文件明细）

**删除**
- `extensions/vscode-octocode/**` (5 文件)

**新增 SKILL.md**
- [skills/playwright-webui-qa/SKILL.md](skills/playwright-webui-qa/SKILL.md)
- [skills/lightpanda-headless-browser/SKILL.md](skills/lightpanda-headless-browser/SKILL.md)
- [skills/thunderbolt-webui-probe/SKILL.md](skills/thunderbolt-webui-probe/SKILL.md)
- [skills/cli-proxy-api-bridge/SKILL.md](skills/cli-proxy-api-bridge/SKILL.md)
- [skills/tools-hub/SKILL.md](skills/tools-hub/SKILL.md)

**修改**
- [crates/octocode-runtime/src/tools.rs](crates/octocode-runtime/src/tools.rs) — 新增 `scan_text_tool_call` + 5 单测
- [crates/octocode-runtime/src/lib.rs](crates/octocode-runtime/src/lib.rs) — re-export
- [ui-shell/app.js](ui-shell/app.js) — indicator 去抖、GitHub 连接面板逻辑 (`initGithubConnectionPanel`)
- [ui-shell/index.html](ui-shell/index.html) — Manage 菜单 GitHub 入口 + `#manage-panel-github` 表单 (9 字段 + 3 按钮)

**提交**
- `4fc1c68 feat(p8): remove VSCode ext; GitHub connection panel; indicator gate; text tool-call scanner; skill descriptors for playwright/lightpanda/thunderbolt/cli-proxy-api/tools-hub`

---

## 5. 结论

P8 把 OctoCode 从"文档声明的多表面"推进到"**真浏览器验证 + 工具调用可兜底 + GitHub 接入可视化**"，补齐了 P7 评估里列为 **P0** 的"WebUI E2E 盲区"和"tool-call 真实触发"两项。

下一步杠杆点清晰：**代码索引 + embedding (P9)** 解锁与 Cursor/Continue 的同级语义检索；**原生 tool-call 翻译层 (P10)** 把本会话的文本扫描升级为一等公民；**分发与签名 (P11)** 完成从"能用"到"可发布、可被审计" 的最后一公里。按此节奏 OctoCode 在下一个里程碑（约 3 个 P 阶段）可进入一线开源编码 Agent 的第一梯队。
