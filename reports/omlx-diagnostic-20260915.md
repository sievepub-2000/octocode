# oMLX 运行异常诊断报告

- 检查主机：4 号机（192.168.10.4）
- 检查日期：2026-09-15
- 结论：oMLX 进程和普通文本生成正常；OpenAI 工具调用链未通过验收，当前不适合作为 OctoCode Agent 的可靠后端。
- 本报告不包含 API 密钥或主机密码。

## 一、现场状态

| 项目 | 已验证结果 |
|---|---|
| 系统 | macOS 26.6.2，Build 25G83，arm64 |
| 服务进程 | `omlx-server`，PID 2095，用户 zillafan，PPID 1 |
| 监听 | `*:8000` |
| 启动链 | launchd → `omlx.service` → `scripts/omlx_start.sh` |
| Python | Homebrew Python 3.13.15 |
| oMLX | 0.7.0.dev2 |
| MLX / mlx-lm / mlx-vlm | 0.32.2 / 0.31.3 / 0.6.3 |
| PyTorch | 2.14.0，已安装；不是当前故障根因 |
| 模型目录 | `/Users/zillafan/llmserver/models/qwen38-flash-next` |
| 模型文件 | 21 个 safetensors 分片，约 106.3 GB |
| 模型配置 | `model_type=qwen4_exp`，`Qwen4ExpForConditionalGeneration` |
| 上下文 | runtime 与模型配置均为 262144 |
| MTP | 已启用；日志确认 MTP path activated |
| 当前默认模型 | `qwen38-flash-next`，instruct profile，禁用 thinking |

## 二、实际接口测试

### 1. 普通中文生成：通过

使用正确认证和模型标识，通过 `/v1/chat/completions` 请求“只回复四个汉字：中文通过”，得到 HTTP 200，返回文本 `中文通过`，2 个输出 token，总耗时约 1.05 秒。

这说明服务监听、认证、模型加载、UTF-8 输出和普通生成主链路均可工作。此前看到的乱码不能简单归因于 macOS 或 Python 编码；需要区分终端显示问题与模型原始响应。

### 2. OpenAI tools 工具调用：未通过

使用 `echo_test(message)`、`tool_choice` 指定该函数、`temperature=0` 测试：

- HTTP 200，但没有 `message.tool_calls`；
- 一次响应为 `content="result:"`、`completion_tokens=2`；
- 另一次响应为空内容、0 输出 token、`finish_reason=stop`；
- 没有产生可供客户端执行的结构化工具调用。

因此，当前问题不是端口不通或模型名无法加载，而是模型输出到 oMLX 工具解析再到 OpenAI `tool_calls` 的协议链不闭合。

## 三、根因分析

### 根因 1：模型身份、模板和解析器存在真实不匹配

oMLX 自动推断并启用了 `VLM tool calling enabled: parser=qwen3_coder`。模型的 `chat_template.jinja` 也包含 Qwen Coder 风格 XML：

`<tool_call><function=name><parameter=...>...</parameter></function></tool_call>`

但是模型配置是 `model_type=qwen4_exp`、`architectures=Qwen4ExpForConditionalGeneration`。当前运行时把一个 Qwen4Exp 架构、目录名为 qwen38 的自定义/转换模型，按 Qwen3 Coder XML 工具调用路径处理。模板标记可以触发解析器选择，但不能证明权重真的按该协议训练或与该解析器兼容。这是工具调用失败的最高可能性根因。

### 根因 2：模型确实生成过不完整或非法的工具包络

oMLX 日志记录了 `JSON validation failed: Failed to extract valid JSON from output`、`Unclosed tool-call envelope`，并记录过 `<tool_call>...<parameter=message>hello</parameter> )\\)` 尾部；预期的 `</function>\\n</tool_call>` 没有出现。

解析器拒绝未闭合 XML 是正确的安全行为；如果强行截断或猜测闭合标签，会把普通文本误执行成工具调用。另一次模型在工具提示下直接生成 `result:` 或提前结束，说明不只是解析器容错问题，模型行为本身也不稳定。

### 根因 3：历史/客户端存在模型名称漂移

日志确认 `qwen3.8-flash-next` → 404（可用名称是 `qwen38-flash-next`），以及 `grok-4.6` → 404（可用名称是 `qwen38-flash-next`）。这会直接造成访问不到模型。历史对话里的旧请求不会自动被服务端改写。

### 根因 4：认证错误是独立问题

日志中的 401 来自无 Authorization 或错误 API key 的探测请求。带正确认证的普通和工具请求都能到达模型，说明认证配置已生效；客户端必须始终发送认证头。

### 非根因：Metal cap、缓存和 MTP

Apple Metal cap 提示是资源调优警告，不会解释工具调用缺失。`boundary_snapshot_unavailable` 是为避免保存不可切片状态而主动跳过的保护逻辑。当前 MTP 已激活。把所有实验性开关全部打开不能修复协议不兼容，反而会增加变量和崩溃风险。

## 四、稳妥解决方案

1. 统一模型标识：所有 OctoCode、测试脚本和客户端只使用 `/v1/models` 返回的规范 ID `qwen38-flash-next`，不要使用 `qwen3.8-flash-next` 或 `grok-4.6`。
2. 核对该 checkpoint 的官方工具调用协议、转换脚本和训练模板。若官方协议不是 qwen3_coder XML，应使用匹配的 parser/template；不能仅按目录名或少量标记猜测。
3. 设置硬验收条件：固定工具请求必须返回非空 `message.tool_calls[0]`，函数名 `echo_test`，参数 JSON 中 `message=hello`；然后再运行 OctoCode 终端采集 Agent 测试。普通文本通过不代表 Agent 通过。
4. 若 checkpoint 没有可靠工具调用支持，保留它作为普通对话模型；Agent 场景改用明确支持 OpenAI/Qwen 工具调用的已验证 checkpoint。不要在服务端对半截 XML 做执行型补标签。
5. MTP、缓存、chunked prefill 和当前内存保护先保持不变；协议验收通过后再单变量评估 PLE、expert offload、specprefill、DFlash、TurboQuant。
6. Metal cap 只有在实测内存压力确有需要时才处理；它需要系统级 sysctl 权限，不是本次工具调用修复的必要步骤。

## 五、当前判定

- oMLX 服务存活：通过
- 模型可发现/可加载：通过
- 普通中文输出：通过
- UTF-8 主链路：当前直接接口测试通过
- 正确模型名访问：通过
- OpenAI 结构化 tools：失败
- OctoCode Agent 执行：失败，阻塞点在 oMLX/模型工具协议链
- oMLX 已完成修复：否；本轮完成的是证据化诊断，尚未对模型模板、解析器或权重做未经验证的改动

下一步应先核对该模型的官方工具协议，再只改一个兼容点并重复固定工具调用验收。
