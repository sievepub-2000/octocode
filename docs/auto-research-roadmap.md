# Octocode Auto-Research Roadmap

> 目标：量化超越 Claude Code、Codex CLI、Cursor、ClawCode
> 淘汰标准：同类/相似功能模块在功能**和**性能上均超过上述所有项目

---

## 竞品对标分析（2026-04-17 基线）

| 维度 | Claude Code | Codex CLI | Cursor | ClawCode | **Octocode** | **目标** |
| ---- | ---------- | --------- | ------ | -------- | ------------ | -------- |
| 工具系统 | 7/10 | 4/10 | 8/10 | 9/10 | 5/10 | **10/10** |
| Provider支持 | 2/10 | 7/10 | 5/10 | 8/10 | 5/10 | **9/10** |
| 插件生态 | 10/10 | 3/10 | 5/10 | 7/10 | 2/10 | **9/10** |
| 会话管理 | 7/10 | 5/10 | 6/10 | 9/10 | 8/10 | **10/10** |
| 本地离线 | 2/10 | 1/10 | 4/10 | 8/10 | 7/10 | **10/10** |
| UI/UX体验 | 8/10 | 6/10 | 10/10 | 5/10 | 6/10 | **9/10** |
| 安全/权限 | 6/10 | 7/10 | 6/10 | 9/10 | 7/10 | **10/10** |
| 性能/延迟 | 5/10 | 6/10 | 8/10 | 8/10 | 8/10 | **9/10** |
| 可扩展性 | 9/10 | 5/10 | 6/10 | 7/10 | 8/10 | **10/10** |
| **综合** | 7.2 | 6.1 | 6.9 | 7.4 | **6.5** | **9.6** |

---

## 量化目标

### 性能指标

- API 响应延迟 < 200ms（非 provider 调用部分）
- provider health probe 缓存命中率 > 95%（TTL 5s）
- 工具执行返回 < 500ms（本地操作）
- 回归测试通过率 100%（全量 case）
- 本地 Ollama provider 首 token 延迟 < 2s

### 功能覆盖

- 工具数量：当前 8 → 目标 25+（>ClawCode 18）
- Slash 命令：当前 12 → 目标 30+
- 支持 Provider 类型：当前 3 → 目标 8+（Anthropic/OpenAI/Ollama/LlamaCpp/Gemini/DashScope/Groq/Stub）
- Plugin/Hook 系统：0 → 完整生命周期（PreTool/PostTool/SessionStart/Stop）
- MCP transport：0 → stdio + WebSocket

---

## 迭代计划

### Iteration 1（当前）：工具扩充 + Slash补全 + Provider扩展

**目标**: 工具 8→15，Slash 12→22，Provider +Ollama
**验证**: 回归 59→75+ passing

| # | 功能 | 文件 | 状态 |
| - | ---- | ---- | ---- |
| 1.1 | 新增 7 个工具 (git-diff/log/status/file-tree/append-file/http-get/read-context) | tools.rs | 🔄 |
| 1.2 | Slash 命令补全 (+git,+context,+tree,+tokens,+fetch,+append) | server.rs+commands | 🔄 |
| 1.3 | Ollama provider 完整接入 | octocode-api | ✅ |
| 1.4 | CLAUDE.md / AGENTS.md 自动解析注入 | runtime | ✅ |
| 1.5 | Token 计数与会话成本追踪 | core+runtime | 🔄 |

### Iteration 2：Plugin/Hooks + Session Fork + VS Code

**目标**: 完整插件生命周期，会话分支，VS Code 扩展基础

| # | 功能 | 文件 | 状态 |
| - | ---- | ---- | ---- |
| 2.1 | Hook 系统 (PreToolUse/PostToolUse/SessionStart/Stop) | octocode-plugins | 🔄 |
| 2.2 | Plugin 加载器 (文件系统扫描 + 动态启用/禁用) | octocode-plugins | ⏳ |
| 2.3 | 会话 fork 与 branch 管理 | session.rs | ⏳ |
| 2.4 | VS Code 扩展基础 (Language Server 适配) | octocode-vscode | ⏳ |
| 2.5 | Agent 多步工作流 (条件分支+循环) | workflow.rs | ⏳ |

### Iteration 3：UI 深化 + 代码理解 + MCP

**目标**: Rich UI，AST 分析，完整 MCP lifecycle

| # | 功能 | 文件 | 状态 |
| - | ---- | ---- | ---- |
| 3.1 | Canvas UI Markdown 渲染 | ui-shell | ⏳ |
| 3.2 | AST 分析工具 (go-to-definition, references) | tools.rs | ⏳ |
| 3.3 | MCP stdio transport 完整实现 | octocode-mcp | ⏳ |
| 3.4 | Dark/Light 主题支持 | app.css | ⏳ |
| 3.5 | 团队会话共享基础 | session.rs | ⏳ |

### Iteration 4：SDK + Marketplace + 生产部署

**目标**: 完整的 SDK/API、Plugin Marketplace

| # | 功能 | 文件 | 状态 |
| - | ---- | ---- | ---- |
| 4.1 | TypeScript/Python SDK | sdk/ | ⏳ |
| 4.2 | Plugin Marketplace (本地目录索引) | octocode-marketplace | ⏳ |
| 4.3 | 自更新机制 | octocode-cli | ⏳ |
| 4.4 | 多用户/组织权限 | octocode-auth | ⏳ |

---

## 参考项目路径

- `C:\Users\周浩\vscode-workspace\github\claude-code\` — Claude Code 插件示例
- `C:\Users\周浩\vscode-workspace\github\claw-code\` — ClawCode 参考
- `C:\Users\周浩\vscode-workspace\github\codex\` — Codex CLI 架构
- `C:\Users\周浩\vscode-workspace\github\cursor\` — Cursor 功能参考

## 已迁移至工作区的测试目录

- `C:\Users\周浩\vscode-workspace\test\` — 原 C:\ 根目录测试/分发目录（已迁移）
