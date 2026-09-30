# oh-my-pi（omp）与 FastAPI 对照调研及补齐（2026-09-18）

调研对象：
- **oh-my-pi**：can1357/oh-my-pi（约 3.2 万星），TypeScript/Bun 编写的终端编程 Agent，源码克隆在 `D:\cc-workspace\octocode-research\oh-my-pi`。依据是它的 `docs/`，包括 models、providers、lsp-config、tools/*、advisor-watchdog、ttsr、rpc 和 sdk。
- **FastAPI**：fastapi/fastapi（约 10.2 万星），Python Web 框架。OctoCode 内置 Python 已带 fastapi 0.141、uvicorn 0.52、pydantic 2.13、sse-starlette。

结论先行：OctoCode 的 LSP 和调试已与 omp 同级，这两项不需要补。差距在三处：**网页搜索**、**编辑后自检**、**外部程序接入**。三处本轮都已补上。**模型回退链**和 **advisor 旁路审查**两项工程量较大，已列入后续计划。

## 1. 模块对照

| 模块 | omp | OctoCode（本轮后） | 判断 |
|---|---|---|---|
| 模型供应商 | 约 60 个托管 provider，外加 Ollama、llama.cpp 和 LM Studio 的隐式本地发现，以及 LiteLLM 元数据发现 | 41 个 provider；每个 provider 都能“获取模型列表/保存”（本批次任务 4）；OpenAI 与 OpenAI 兼容两类已分开 | 覆盖够用。本地发现靠“获取模型列表”手动完成，omp 是自动的 |
| 模型角色 | default、smol、slow、vision、plan、commit、tiny、task、advisor 共 9 个角色，每个角色可带思考档位后缀 | 主模型 1 个，会话摘要、图片描述等内部用途固定走同一模型 | 差距小。本地单模型部署下意义不大 |
| 思考档位 | 按角色写后缀，如 `:low`、`:high` | 本轮新增：自动识别、对话栏档位选择器、不匹配时回退、服务端拒绝时降级 | 已对齐，且多了服务端拒绝自动降级 |
| 回退链 | `contextPromotionTarget`：上下文溢出时先切到更大上下文的模型，再考虑压缩 | 只有压缩和有限重试（`max_retries = 4`） | **差距**，列入后续 |
| 内置工具：读/写/改 | read、write；hashline 编辑（行哈希锚点）；ast_edit 和 ast_grep | harness 自带 hashline 编辑（`grok_build_hashline`）、grep、read_file 和 write | 同级。缺 AST 结构化编辑，可用 code-review-graph MCP 和 LSP 的 rename 部分替代 |
| 终端与后台 | bash、PTY 和后台任务 | run_terminal_command、后台命令和 monitor | 同级 |
| 子 Agent | task，外加 agent-hub | task（harness 子 Agent） | 同级 |
| 记忆 | recall、retain、reflect、memory_edit，以及 mnemosyne 后端 | 统一为 harness 记忆：Markdown、BM25、dream 整理，跨会话共享；知识类内容走 llmwiki | 同级，且更精简 |
| LSP | `lsp` 工具，14 个动作（diagnostics、definition、references、hover、symbols、rename、rename_file、code_actions、type_definition、implementation、status、reload、capabilities、request） | `code_intelligence` MCP，同样 14 个动作，复用 VS Code 已加载的语言服务器，无需另起进程 | **已对齐** |
| 写后诊断 | 每次写文件后自动附带 LSP 诊断 | 本轮新增提示词规则：改完代码先调 `code_intelligence diagnostics`，没有该工具时跑项目的类型检查或 lint | 基本对齐：omp 在工具层强制，OctoCode 靠提示词约束 |
| 调试 | `debug` 工具，27 个 DAP 动作（launch、attach、断点、单步、evaluate、内存、反汇编等） | `debug_session` MCP，同样 27 个 DAP 动作，走 VS Code 的全部调试适配器 | **已对齐** |
| 浏览器 | browser（headless）和 computer-use | 工作台浏览器、obscura（headless），以及本轮设为默认的 Scrapling（带浏览器指纹的抓取和本地 Chrome 渲染） | 同级 |
| 网页搜索 | 24 个后端顺序回退：各家 API，外加 DuckDuckGo、Startpage、Mojeek、SearXNG 等免 key 抓取 | 原先只有“拼一个 Bing 页面”这一条路，而且 `search_web` 在生产环境根本没有注册。本轮在 Scrapling MCP 里新增 `search`：Bing → Brave → DuckDuckGo → Mojeek 顺序回退，返回结构化结果 | **已补**。免 key 后端比 omp 少，但本机出口能用的都已覆盖 |
| 旁路审查 | advisor/WATCHDOG：另一个模型旁听并注入建议 | 无 | 差距，列入后续 |
| 流式规则 | TTSR：输出流命中规则时中断，注入规则后重试 | 无；仅有 `--rules` 每轮重发 | 差距小，本地模型收益有限 |
| 接入方式 | 交互式、SDK、RPC（stdio JSON）、ACP | 桌面应用，以及 harness 命令行和 ACP；**原先没有 HTTP 入口** | **已补**：FastAPI HTTP API，见第 3 节 |

## 2. 本轮已落地

1. **Scrapling `search`**（`environments/scripts/scrapling_mcp.py`）
   - 免 key，多引擎按 Bing → Brave → DuckDuckGo → Mojeek 的顺序回退，前一个无结果或出错就换下一个。
   - 自动解开 Bing（`/ck/a?...u=a1<base64>`）和 DuckDuckGo（`/l/?uddg=`）的跳转链接，并过滤广告。
   - 实测（本机出口）：Bing 和 Brave 返回正常结果；DuckDuckGo 返回 202，Mojeek 返回验证码页，链路记录失败原因后自动跳过。中文查询“北京 天气”返回中国天气网和中央气象台的页面。
2. **提示词**
   - `<web>` 段改为优先使用 Scrapling `search`，再用 `get` 或 `fetch` 取正文。
   - `<principles>` 新增“改完代码先查诊断”一条。
   - 模板 214 项测试全部通过。
3. **FastAPI HTTP API**（`environments/scripts/octocode_api.py`），见下节。
4. **顺带修复**
   - web_fetch 的 3 个单元测试在 Windows 上失败，原因是测试里路径分隔符混用，以及 `which` 需要 `.exe` 后缀。修复后 127 项全部通过。
   - host 里残留的 `AgentRole::Curator` 进程角色和 `--allow MCPTool(octocode-workbench__curation)` 已删除。这是记忆合并后遗留的死代码。

## 3. FastAPI 调研与 OctoCode HTTP API

omp 可以通过 SDK 和 RPC 被脚本、CI 驱动，OctoCode 只能在桌面应用里用。FastAPI 与这个缺口正好对应：
- 用 pydantic 模型定义请求，校验和错误信息自动生成；
- `/docs` 自动生成 OpenAPI 交互文档，调用方无需另写 SDK；
- 鉴权可以作为依赖注入复用；
- `StreamingResponse` 可以直接输出 SSE 事件流。

内置 Python 已经带齐这些依赖，不需要新增包。

**接口**

启动命令：

```powershell
"$env:OCTOCODE_PYTHON_BASE" "$env:OCTOCODE_ENVIRONMENTS\scripts\octocode_api.py" --port 8765
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 显示 harness 路径、存储目录，以及当前默认模型（应用最近一次使用的模型） |
| POST | `/v1/runs` | 发起一次运行。参数包括 `prompt`、`cwd`、`session_id`、`resume`、`max_turns`、`permission_mode` 和 `model{model, base_url, api_key, context_window}`；设 `wait: true` 时同步等待结束 |
| GET | `/v1/runs`、`/v1/runs/{id}` | 查询运行列表和单次运行的状态，包括文本、工具调用、token 用量和轮数 |
| GET | `/v1/runs/{id}/events` | SSE：先回放已有事件，再推送实时事件，结束时发送 `event: done` |
| POST | `/v1/runs/{id}/cancel` | 取消运行 |

**设计要点**
- harness 的启动参数与 host 完全一致：`--todo-gate`、禁用 xAI 专属工具、`streaming-json` 输出；并注入 `OCTOCODE_MEMORY_DIR`，使 API 会话与桌面会话**共用同一份记忆**。
- 模型默认沿用应用最近一次会话的配置，包括思考参数。配置里指向应用内部的工作台 MCP 地址和令牌，这部分不带过来。请求可以覆盖模型配置；API key 取自请求或 `OCTOCODE_MODEL_API_KEY`，不落盘。
- 默认只监听 127.0.0.1。要监听非本机地址，必须设置 `OCTOCODE_API_TOKEN`，客户端以 Bearer 方式携带，否则拒绝启动。原因是这个 API 会运行一个能改文件的 Agent。
- 同一会话同时只允许一个运行，并发请求返回 409。按 `NO_PROXY` 规则绕过代理访问模型地址。

**实测**（对接 4 号机 qwen38-flash-next:instruct）
1. `wait=true`，任务是“创建 hello.py 并运行”：149 秒完成，文件已生成，输出 `5`，调用了 10 次工具。
2. 用同一 `session_id` 加 `resume=true` 续问：模型答出上一轮创建的文件和输出。SSE 逐段推送文本后发出 `done`。

## 4. 后续建议（未做）

- **上下文溢出时切换模型**：在 harness sampler 捕获 context_length 类错误后，切到配置好的后备模型。改动集中在 `xai-grok-sampler`，模式与本轮的 thinking 降级相同。
- **advisor 旁路审查**：用第二个便宜模型定期审阅对话记录并注入建议，适合长任务防跑偏。
- **本地 provider 自动发现**：启动时探测 `127.0.0.1:11434`、`:1234`、`:8080` 以及已配置 LAN 地址的 `/v1/models`。
