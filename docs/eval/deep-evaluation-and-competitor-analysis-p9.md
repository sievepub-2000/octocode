# OctoCode — P9 评估与增量报告

> 上一版：[P8 报告](deep-evaluation-and-competitor-analysis-p8.md) — HEAD `54526bb`
> 本版基线：P9 系列提交（见 §4）
> 分支：`fix/ui-stream-indicator-and-bench-flake`

---

## 0. P9 本会话已交付

| 编号 | 需求 | 状态 | 证据 |
|---|---|---|---|
| P9-A | 工作区代码索引 CLI：`index build / query / status` | ✅ | 新增 [crates/octocode-cli/src/index.rs](../../crates/octocode-cli/src/index.rs) + main.rs 拦截 + ALL_SUBCOMMANDS；10 单测 |
| P9-B | 批量登记 11 个外部项目为 SKILL.md 描述符 | ✅ | `skills/` 新增 11 个目录（见 §2） |
| P9-C | WebUI 真实浏览器 E2E 进 CI（`cli-smoke.yml` 新 job） | ✅ | [.github/workflows/cli-smoke.yml](../../.github/workflows/cli-smoke.yml) 新增 `webui-e2e` job + [scripts/webui-e2e.js](../../scripts/webui-e2e.js) |
| P9-D | 质量门：clippy `-D warnings` + 全量 cargo test | ✅ | `318 passed / 0 failed`；clippy EXIT=0 |

---

## 1. P9-A：代码索引 MVP

### 1.1 设计抉择

| 维度 | 当前选择 | 未来演进（P10/P11） |
|---|---|---|
| 语言粒度 | 按词法 token（ASCII alnum + `_`，下限长度 2） | tree-sitter AST，按符号定义边界 |
| 存储 | JSON 单文件 `.octocode/index.json` | sqlite-vec / lancedb 向量 + 倒排混合 |
| 评分 | 查询词 token 出现计数 | BM25 / 余弦（embedding） |
| 文件范围 | 白名单 34 种扩展名 + 黑名单 20 目录 | `.gitignore` 原生尊重 |
| 依赖 | 仅 `serde` / `serde_json` | `tree-sitter-<lang>`, 可选 `rusqlite` |

**关键不变式**：索引是**纯派生物**，可随时 `index build` 重建；不嵌入业务逻辑，`query` 不触发任何网络请求。

### 1.2 对外契约

```
$ octocode-cli index build
{
  "ok": true,
  "path": ".octocode/index.json",
  "schema_version": 1,
  "file_count": 1234,
  "unique_token_count": 45678,
  "built_at_unix": 1745436000
}

$ octocode-cli index query alpha_beta --top 3
{
  "ok": true,
  "terms": ["alpha_beta"],
  "top_k": 3,
  "hit_count": 2,
  "hits": [
    { "path": "src/lib.rs", "score": 2, "matched": ["alpha_beta"] },
    ...
  ]
}

$ octocode-cli index status
{
  "schema_version": 1,
  "present": true,
  "path": ".octocode/index.json",
  "file_count": 1234,
  ...
}
```

### 1.3 测试覆盖（10 新单测）

| 测试 | 作用 |
|---|---|
| `tokenize_splits_on_punctuation_and_lowercases` | 分词正确性 |
| `tokenize_drops_short_tokens` | < 2 字符 token 丢弃 |
| `build_index_walks_workspace_and_skips_target_dir` | 目录黑名单生效（target/ node_modules/ 不入库） |
| `persist_and_load_roundtrip` | JSON 序列化闭合 |
| `query_ranks_by_token_overlap` | 排序稳定、得分正确 |
| `status_reports_absent_when_no_index` | 无索引态 |
| `status_reports_present_after_build` | 有索引态 |
| `dispatch_status_returns_json` | 子命令 JSON 输出 |
| `dispatch_build_then_query` | 端到端 build → query |
| `dispatch_unknown_sub_errors` + `dispatch_help_mentions_all_subs` | 错误路径 + help |

---

## 2. P9-B：Skill Hub 批量登记

P8 已登记 5 个（playwright / lightpanda / thunderbolt / cli-proxy-api / tools-hub）。P9 补齐用户清单的其余项：

| 目录 | 集成模式 | 当前状态 | 说明 |
|---|---|---|---|
| `skills/pentagi/` | `external-agent` | descriptor-only | 攻防 agent，**默认禁用**，需显式 allowlist |
| `skills/code-review-graph/` | `external-library` | descriptor-only | 未来 `review-graph` 子命令基础 |
| `skills/inkos/` | `reference-only` | descriptor-only | `tui.rs` 组件化重构参考 |
| `skills/claude-design/` | `reference-only` | descriptor-only | WebUI 交互规范（与 P8 indicator 修复对齐） |
| `skills/webnovelwrite/` | `reference-only` | descriptor-only | 写作模式 preset 的设计输入 |
| `skills/naive-ui/` | `reference-only` | descriptor-only | 未来 `ui-shell/modules/*` 拆分的形状参考 |
| `skills/andrej-karpathy-skills/` | `reference-only` | descriptor-only | 与 `autoresearch`/`get-shit-down` 元循环一致 |
| `skills/markitdown/` | `external-library` | descriptor-only | Docling 的轻量回退 |
| `skills/claude-mem/` | `reference-only` | descriptor-only | `/memories/` 三层作用域的评审 rubric |
| `skills/claude-auto-research/` | `reference-only` | descriptor-only | 未来 `/research` slash 命令模板 |
| `skills/agent-skills/` | `internal` | documented | **Skill 描述符 schema 的权威文档** |
| `skills/ligh/` | `reference-only` | descriptor-only | 上游标识歧义，占位等用户澄清 |

> `skills/deeptutor/` 已在 P8 之前就存在，无需重复登记。

### 2.1 P8 契约兑现（tools-hub 视图）

- `skills-list` 在 **下一次 CLI 运行** 立即反映新增/删除。无缓存、无守护进程。
- 通过 `octocode_skills::SkillRegistry::discover(workspace_root, user_config_home)` 走目录扫描，零配置。
- `skills/agent-skills/SKILL.md` 作为模板文档，把描述符 schema 变成可验证字段。

---

## 3. P9-C：WebUI 真实 E2E 入 CI

### 3.1 工作流变更

文件：[.github/workflows/cli-smoke.yml](../../.github/workflows/cli-smoke.yml)

1. **现有 `smoke` job** 新增一步 `Smoke — index build + status + query`，保证 P9-A 的 CLI 契约不被静默回归。
2. **新增 `webui-e2e` job**（Ubuntu）：
   - 触发条件：`push` to `main` **或** PR 上带有 `run-webui-e2e` 标签。
   - 步骤：`cargo build --release` → `npm install --no-save playwright` → `npx playwright install --with-deps chromium` → `serve --port 995` → `node scripts/webui-e2e.js` → 上传截图 artifact → stop server。
   - Chromium 默认禁止 port 995，用 `--explicitly-allowed-ports=995` 通过。

### 3.2 验证脚本 [scripts/webui-e2e.js](../../scripts/webui-e2e.js)

断言三件事：

1. `GET http://127.0.0.1:995/` 返回 **HTTP 200**。
2. 初始页面 `#stream-indicator` **hidden**（P8 修复持久性保护）。
3. `Manage → GitHub` 面板暴露 **9/9** 字段。

截图输出 `tmp-webui-github-panel.png` 作为 artifact，失败时仍上传便于排查。

Auth token 从 `os.tmpdir()/octocode-auth-<port>.token` 读取（`serve` 启动时写入），通过 Playwright `storageState` 注入 localStorage，规避 UI 登录流程。

---

## 4. 提交清单

预计单个原子提交：

```
git add crates/octocode-cli/src/index.rs \
        crates/octocode-cli/src/main.rs \
        skills/pentagi skills/code-review-graph skills/inkos \
        skills/claude-design skills/webnovelwrite skills/naive-ui \
        skills/andrej-karpathy-skills skills/markitdown skills/claude-mem \
        skills/claude-auto-research skills/agent-skills skills/ligh \
        scripts/webui-e2e.js \
        .github/workflows/cli-smoke.yml \
        docs/eval/deep-evaluation-and-competitor-analysis-p9.md

git commit -m "feat(p9): token-based index CLI (build/query/status); webui-e2e CI job; 11 skill descriptors"

git push origin fix/ui-stream-indicator-and-bench-flake
```

---

## 5. 同类产品对比（P9 增量）

只标注 P9 相对 P8 的变化：

| 维度 | OctoCode (P8) | OctoCode (P9) | 同类最佳 |
|---|---|---|---|
| 代码索引 | ⛔ | ✅ 倒排 + 打分（MVP） | Cursor ✅ / Continue ✅（都是向量） |
| CI WebUI E2E | ✅ 本地 Playwright | ✅ **CI 自动化** | Cline 部分 / OpenCode 部分 |
| Skill hub 规模 | 18 | **29**（+11） | — |
| Skill schema 权威文档 | 隐式 | ✅ `skills/agent-skills/SKILL.md` | — |

与 Cursor/Continue 的差距：它们已用向量检索；OctoCode 的倒排是更透明、可在零依赖下跑的起点。**P10 的 tree-sitter + embedding 升级** 是缩小这项差距的关键杠杆。

---

## 6. 剩余风险与 P10–P11 路线

### 6.1 P9 已做、但未彻底的事
- `ui-shell/app.js` 的 ESM 化未推进（脚注：P8 报告已列入 P9，本次延后到 P10）。
- 11 个新 skill 仍是 **描述符 + 未来运行时契约**，真实子进程/库接入在 P10/P11 分批落地。

### 6.2 P10 优先级
1. **原生 `tool_calls` 翻译层**：`ToolCallTranslator` trait，默认实现按 provider 区分，配合 `scan_text_tool_call` 做兜底。
2. **tree-sitter + 向量索引**：切换 `crates/octocode-cli/src/index.rs` 的后端，但保持 CLI 契约不变（`index build/query/status`）。
3. **`ui-shell/app.js` → 模块化**：`<script type="module">` + `ui-shell/modules/*`，配合 Playwright E2E 做防回归。
4. **批启用 skill 运行时**：优先 `markitdown`（MCP adapter）+ `code-review-graph`（子进程）。

### 6.3 P11 优先级
1. 桌面签名与自动更新（macOS notarize / Windows sign）。
2. `octocode/mcp-server:latest` Docker 镜像（Alpine + musl 静态二进制）。
3. `skills-install <url>` 带 allowlist & 签名校验。
4. 可观测：Prometheus 指标 + OpenTelemetry traces。

---

## 7. 结论

P9 的三项核心交付（**索引 MVP / 11 skill 批量登记 / CI 化 WebUI E2E**）把 OctoCode 从"单次人工验证"推向"**CI 自带真实浏览器防回归 + 可检索的 29 项技能池 + 可端到端搜索的工作区索引**"。与 P8 报告里预判的节奏一致。

下一跳 **P10 的核心收益** 在于把"文本 tool-call 扫描"升格为"结构化翻译层"以及把倒排索引升格为语义索引——两件都能直接反映在用户对话质量上，而不仅是基础设施指标。

**质量门（本次）**：
- `cargo clippy --workspace --all-targets -- -D warnings` — EXIT 0
- `cargo test --workspace` — 318 passed / 0 failed
- `octocode-cli` 测试：70（P8: 60 → P9: 70，`+10` index 覆盖）

**诚实边界**：
- WebUI E2E 在 CI 里是**首次**落地，**尚未**经过第一轮 PR 触发验证；首次 PR 合并时需观察 `webui-e2e` job 是否因环境差异（Chromium / Node 版本 / 端口）失败，必要时在 workflow 里做兼容调整。
- 11 个新 skill 目前**零运行时依赖**：他们是对未来集成的显式承诺，而不是已生效的能力。
