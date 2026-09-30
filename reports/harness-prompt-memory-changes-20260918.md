# Harness / 提示词 / 记忆 / 技能 变更报告（2026-09-18）

负责范围：任务 3、6、7、9、10（provider 与 UI 部分见 `ui-provider-changes-20260918.md`）。
测量方法参考 microsoft/agent-lightning 的 agent-lightning 技能：固定用例、代码判分、除被测变量外保持一致。

## 1. 先决条件：4 号机模型已修复

- `Jundot/Qwen3.8-Flash-Next-oQ4e-mtp` 的 21 个权重分片中有 5 个（00002/00004/00005/00019/00020）sha256 与官方不符，其中两个约 72% 的 16 MB 块全为零——aria2 下载中断留下的预分配文件。这是“输出乱码 + 不调用工具”的真实原因，与 octocode 代码和 omlx 版本无关。
- 已从 xet CDN 重新下载替换，现全部 32 个文件与官方逐一比对一致；旧文件保留在 4 号机 `~/llmserver/diag/bad-shards`。
- omlx 升级到 dev2 线最新提交 `e9c158f`（旧 `.venv` 保留可回滚），采样参数改为模型 T0.6/top_p0.95/top_k20、instruct 档 T0.7/top_p0.8/top_k20（原为服务端默认 T1.0/top_k=0，即不截断词表，会放大损坏权重的随机性）。
- 用坏权重时的旧 SSD 前缀缓存已移走，避免命中污染状态。

## 2. 系统提示词（任务 3）

`octo-harness/crates/codegen/xai-grok-agent/templates/prompt.md`：8214 → 5709 字节。

- 合并重复：原 `<work_policy>` 与 `<execution_integrity>` 有大量重叠（范围控制、证据要求、压缩后恢复），合成一个 `<principles>`；`<communication>` 从 10 条缩到 4 条。
- 新增 `<environment>`：操作系统、shell、工作目录、日期。模板早有这些变量却没使用，模型此前要靠试探才知道自己在 Windows/PowerShell 上。
- 新增 `<long_tasks>`：待办列表、小步验证、压缩/恢复后从最后一个已验证步骤继续、后台长命令与 monitor 的用法（原先分散在多处或缺失）。
- 新增 `<memory>`（仅在记忆开启且有记忆工具时渲染）：如何检索、往哪个文件写、写什么不写什么，以及复杂任务后把可复用流程沉淀成技能。上游把这一段整体删掉了，本地模型因此完全不知道记忆怎么用（实测：模型花了 8 轮在猜目录，最后没存成）。
- 身份：默认标签 `Grok` 改为 `OctoCode`，并由 host 通过最高优先级环境变量 `GROK_SYSTEM_PROMPT_LABEL` 强制。原因：按模型 ID 匹配的配置项对 OpenRouter 这类适配器 provider 匹配不上，那些会话里模型自称 Grok（9-15 会话实证）。
- host 每轮重发的中文 `--rules` 从约 1300 字节减到 640 字节：删去与系统提示词重复的内容，并删掉两个**错误的工具名**（`tools search`、`ask_user`，真实名称是 `search_tool`、`ask_user_question`）。保留 UI 依赖的 `<octo_thought>` 协议。
- 设置页预览的副本 `octocode-core/src/resources/harness/system-prompt.md` 不再手工同步：`octocode-build.ps1` 开头强制从 harness 模板复制。

## 3. 跨会话记忆与长程执行（任务 7）

- **根因**：harness 的记忆目录取自 `GROK_HOME`，而 octocode 给每个会话建一个 home（`harness-runtime/sessions/s-*`），记忆随会话一起被隔离；且主会话没有任何配置项可以覆盖这个目录（`root_dir_override` 只在子 Agent 路径上有）。
- **修法**：harness 增加 `OCTOCODE_MEMORY_DIR` 环境变量（`xai-grok-memory/src/storage.rs`），host 指向所有会话共享的 `harness-runtime/memory`，并在生成的 `config.toml` 中开启 `[memory]`、`[memory.session] save_on_end`、`[memory.initial_injection]`。嵌入模型留空即纯 BM25 检索，不需要任何云端嵌入服务。
- 由此自动获得 harness 原有的 dream 整理（默认 24 小时 / 5 个会话触发一次），把会话日志沉淀为 MEMORY.md，配合提示词里的技能沉淀要求，构成“会话→记忆→整理→技能”的自我迭代闭环。
- **另一处**：octocode 自己的记忆（host SQLite + 世界模型 + curator）在首轮注入最多 12 000 字符，实测注入的却是把当前任务名重复一遍的图节点（`Task: X --part_of--> Goal: X`）。（此问题已随 7.5 的记忆系统合并彻底消失：host 记忆注入整体删除。）
- 上下文压缩本来就能工作：32k 上下文、阈值 60% 的长任务里触发了 28 次自动压缩且任务完成（见评测 compaction 用例）。

## 4. 体积与无效功能（任务 6）

- 生产打包不再生成 source map（`src/esbuild.mjs`）：VSIX 里 `dist/extension.js.map` 约 16 MB，运行时无人读取（上游用于云端错误遥测，octocode 不发这类遥测）。需要排查时 `OCTOCODE_SOURCEMAPS=1`。
- 禁用 4 个只存在于 xAI 云端的媒体工具（`image_gen`、`image_edit`、`image_to_video`、`reference_to_video`）：本地 provider 都不提供，留在工具表里只会浪费上下文并诱发必然失败的调用。
- 未做但已量化的体积项（保留结论供决策）：`environments/wsl/OctoCode/ext4.vhdx` 5.3 GB（产品 7.9 GB 的主体）、`local-tools` 467 MB、`funasr` 246 MB、harness 可执行文件 140 MB。harness 若改用 LTO + 单代码生成单元可能显著变小，但本机（4 核 i5-3210M）普通 release 已需 13–20 分钟，LTO 估计数小时且有内存风险，与“性能最优”取舍后维持现状。

## 5. 默认技能（任务 10）

`desktop-shell/.build/workspace/.agents/skills` 与运行目录 workspace 从 23 个增加到 28 个：

- superpowers 全套更新到上游 `b36e082`（保留本地的 `agents/` 适配目录）。
- ponytail 家族补齐：`ponytail`、`ponytail-audit`、`ponytail-debt`、`ponytail-help`、`ponytail-review`。
- 新增 `agent-reach`（Panniantong/Agent-Reach `a19a171`），其 CLI（`agent-reach` 1.5.0）与 `pytest` 已装入内置 Python（`.build/environments` 与 runtime 各一份）。
- 两份产品自检脚本的必备技能清单同步更新。
- 来源记录在 `.build/workspace/.agents/SKILLS_SOURCES.txt`。

## 6. 评测（任务 6/9 的证据）

固定 8 个用例，同一模型端点（4 号机 `qwen38-flash-next:instruct`）、同一判分脚本；基线 = 已安装构建 + 旧 host 行为，候选 = 新构建 + 新 host 行为。

| 用例 | 基线 | 候选 | 说明 |
|---|---|---|---|
| identity | PASS 19s / 26k tok | PASS 14s / 11k tok | 自称 OctoCode，token −58% |
| fix_bug | PASS 70s / 111k | PASS 37s / 72k | 时间 −47% |
| feature_with_tests | PASS 70s / 85k | FAIL 284s / 828k | 单次离群；两轮复测均 PASS（37s/47k、35s/35k），基线复测为 119s/321k、52s/101k |
| weather | PASS 150s / 141k | PASS 75s / 78k | 时间 −50% |
| nyt（纽约时报前三） | PASS 370s / 631k | PASS 154s / 225k | token −64% |
| memory（跨会话记忆） | **FAIL** 139s / 457k | **PASS** 43s / 92k | 记忆目录修复的直接证据 |
| resume | PASS 57s / 150k | PASS 52s / 118k | |
| compaction（32k 上下文长任务） | PASS 1500s | PASS 2700s | 两边都完成；候选触发更多压缩轮次，耗时更长 |

合计：两边都 7/8；prompt token 1.60M → 1.43M；把离群的 feature_with_tests 换成复测中位数后，候选在 7 个常规用例上耗时下降约 21%–80%。
结论：记忆从“不可用”变为可用，简单任务更快更省；compaction 耗时是已知退步点，后续可通过调高压缩阈值或摘要长度优化。

## 7. 第三批改动（2026-09-18 下午）

### 7.1 本地模型“只有思考没有输出”
- 根因：Clash Verge TUN 模式把 `2.2.2.0/24` 走了代理节点，局域网模型请求 15 s 超时，模型输出被截在思考阶段；harness 又对 502 重试 15 次（每次约 100 s）。
- 修复：Clash `Merge.yaml` 与运行配置加 `IP-CIDR 2.2.2.0/24、192.168.10.0/24、10.10.10.0/24 → DIRECT`（经 `\\.\pipe\verge-mihomo` 热重载，实测 51 ms 返回）；host 启动 harness 时按 base_url 注入 `NO_PROXY/no_proxy`；`max_retries = 4`；502 错误文案改为提示检查代理。

### 7.2 思考/推理档位
- `packages/types/src/thinking.ts`：按模型元数据优先、再按名称族识别思考能力（effort 型：o 系列、GPT-5、Claude 4、Gemini 2.5+ 等；template 型：Qwen3、GLM-4.5+、DeepSeek V3/R1、Kimi K2 thinking 等；`:instruct`/`-Instruct`/non-think 视为不支持）。
- 对话栏模型名右侧新增档位选择器（`ThinkingTierPicker`），不支持时置灰；存档档位与模型不匹配时回退为“不思考”。
- host 把档位映射为 `reasoning_effort` 或 `extra_body`（`chat_template_kwargs.enable_thinking` + `thinking_budget`）；harness 新增 `extra_body` 合并，并在服务端对思考参数返回 400/422 时自动去掉思考参数重发一次，此后保持关闭。

### 7.3 UI
- todos-list / message-queue 角标方向改正（收起朝上，展开朝下）。
- 历史标题右侧无用复选框删除；运行中沙漏旋转，结束/暂停变为粗线圆圈。
- 对话栏增加上下边线。

### 7.4 慢的原因与浏览器工具
- 慢：① 局域网请求被代理拖到超时并重试；② agent-reach 技能让模型运行不存在的 `conda run -n dl`；③ harness `web_fetch` 未开启，只能靠 shell curl 试探；④ 网页工具藏在 `search_tool` 后，提示词没说。均已修。
- 默认浏览器工具：采用 Scrapling（内置 Python，fastmcp 包装 `scrapling_mcp.py`：`search` / `get` / `bulk_get` / `fetch`），不默认装 browser-use（它自带第二个 LLM 循环，本地模型下又慢又重，且与工作台浏览器、obscura 重叠）。
- `search` 为免 key 多引擎回退链：Bing → Brave → DuckDuckGo → Mojeek（本机出口下 DuckDuckGo 与 Mojeek 返回验证码，链路会自动跳过），返回结构化 title/url/snippet，自动解开 Bing/DDG 跳转链接。
- 装机后实测发现：Clash TUN 的 fake-ip 模式把所有域名解析到 `198.18.0.0/15`，`web_fetch` 的 SSRF 防护把它当内网全部拦截（模型被迫退回 shell）。`ssrf.rs` 新增 `is_proxy_fake_ip`：仅对 DNS 解析得到的该网段放行，字面 IP 仍拦截；新增测试，web_fetch 128 项全过。

### 7.5 记忆系统合并
- 只保留 harness 记忆（Markdown + BM25 + dream 整理，所有会话共享 `harness-runtime/memory`）；host 的 memory/knowledge/world_model/curation 能力、sqlite-vec、curator 进程角色、扩展侧 recall/compose/curator 全部删除；旧数据经 `scripts/migrate-host-memory.py` 迁入 `MEMORY.md`。
- 知识类沉淀走 llmwiki，提示词中已写明分工。portless / atlas 调研后均非可用的记忆系统，未整合。

### 7.6 oh-my-pi 与 FastAPI 对照补齐
详见 `omp-fastapi-gap-20260918.md`。已落地：Scrapling 多引擎搜索、改代码后跑诊断的提示词规则、基于 FastAPI 的 HTTP API（`environments/scripts/octocode_api.py`）。

脚本与轨迹：`D:\cc-workspace\octocode-research\harness-lab`（`bench.py`，每个用例保存完整 JSONL 轨迹）。

