# OctoCode UI / Provider 改动记录（2026-09-18）

负责范围：任务 4（每个 provider 的模型列表获取与保存）、任务 5（对话框贴边）、任务 8（本地模型接入正确的 provider 入口），以及 4 号机 oMLX 的 macOS app 入口。
其余任务（系统提示词精简、agent-lightning、长程任务/上下文压缩/跨会话记忆、qwen 工具调用实测、默认技能、总报告）由并行的另一个会话负责。

## 任务 8：本地模型必须接在 OpenAI Compatible，而不是 OpenAI 官方入口

**问题**：`omlx-qwen38` 这条配置用的是 `openai-native`（OpenAI 官方适配器），base URL 指向 4 号机。官方适配器会按 OpenAI 自家服务的约定发请求（含 OpenAI 专有参数、内置模型目录），本地 oMLX 服务并不理解这些；正确入口是 `openai`（OpenAI Compatible），它从 `GET {baseUrl}/models` 实时发现模型，不发送 OpenAI 专有选项。

**改动**

| 文件 | 内容 |
| --- | --- |
| `octocode-core/src/core/config/openAiNativeEndpointMigration.ts`（新增） | 判定 base URL 是否为官方域（`openai.com` 及其子域，空值视为官方），并把非官方的 `openai-native` 配置转换为 `openai` 配置（保留 base URL、密钥、模型 ID） |
| `octocode-core/src/core/config/ProviderSettingsManager.ts` | 新增一次性迁移开关 `openAiNativeCustomEndpointMigrated`，启动时执行上述转换；新装用户直接标记为已迁移 |
| `webview-ui/src/components/settings/constants.ts` | 两个入口改名为 **OpenAI (Official)** 与 **OpenAI Compatible (Local / Self-hosted)** |
| `webview-ui/src/components/settings/providers/OpenAI.tsx` | 官方入口填了非 openai.com 地址时，显示说明并提供「切换到 OpenAI Compatible」按钮（保留地址/密钥/模型） |

**当前机器的配置切换**：profile 整体保存在加密的 secret storage 里，只能通过 UI 或设置导入修改。已写入
`runtime/data/octocode-import/omlx-qwen38-openai-compatible.json`（openai 兼容 / `http://2.2.2.2:8000/v1` / key `qwen38` / `qwen38-flash-next:instruct` / 262144 上下文），
并在 `data/user-data/User/settings.json` 里设置 `octocode.autoImportSettingsPath` 指向它。
⚠️ **导入生效后必须删除该设置**，否则每次启动都会覆盖用户后续的修改。

## 追加：base URL 优选列表（逗号分隔）

安装后把 `openAiBaseUrl` 改成了 `http://2.2.2.2:8000/v1,http://192.168.10.4:8000/v1`（有线优先、拔线回落 Wi-Fi）。`octocode-host/src/endpoint.rs` 本来就把逗号列表当优选列表并做 TCP 探测，但**扩展侧不认**：`OpenAiHandler` 会把整串当成 baseURL（影响「增强提示词」等直接走扩展 provider 的功能），`getOpenAiModels` 也会因为 URL 非法直接返回空列表，导致任务 4 的「获取模型列表」对这条配置必然失败。

已补：`octocode-core/src/api/providers/baseUrlPreferenceList.ts`（新增）提供 `parseBaseUrlPreferenceList` / `primaryBaseUrl`（按逗号切分、去空格与尾斜杠）；`OpenAiHandler` 取列表第一项，`getOpenAiModels` 依次尝试直到某个地址返回模型。单个地址的行为完全不变。测试：`api/providers/__tests__/baseUrlPreferenceList.spec.ts`。

## 任务 4：每个 provider 都能手动获取模型列表并保存所选模型

原先只有 OpenAI 官方与 OpenAI Compatible 两个面板有「获取模型」按钮，其余 provider 只能依赖自动获取。

**后端**（`octocode-core/src/core/webview/providerModelList.ts`，新增；`webviewMessageHandler.ts` 接线）
- 新消息 `requestProviderModels` → 回复 `providerModels`，按 provider 分派：
  - 路由类（openrouter / requesty / litellm / ollama / lmstudio / poe / deepseek / moonshot / kimi-code 等）：先清该 provider 的缓存，再走既有 `getModels`；
  - `openai` / `openai-native`：`getOpenAiModels`；
  - `anthropic`：`/v1/models`（`x-api-key` + `anthropic-version`）；
  - 已确认支持 `/models` 的 OpenAI 兼容云：mistral、xai、sambanova、fireworks、baseten、gemini（去掉 `models/` 前缀）；
  - 其余（bedrock、vertex、openai-codex，以及未确认 `/models` 的 friendli、mimo、minimax、zai、qwen-code）回落到内置目录。
- 请求 10 秒超时，任何失败都不抛出，降级为内置目录 + 错误说明。
- 成功结果按 `provider|baseUrl` 存入 globalState（`providerModelListCache`，上限 50 条，**不保存密钥**）；未带 `refresh` 时直接回放缓存，打开设置页不会产生额外请求。
- 手动获取后同时补发既有的 `routerModels` / `ollamaModels` / `lmStudioModels` / `vsCodeLmModels` 消息，让各 provider 自己的选择器同步刷新。

**前端**
- `webview-ui/src/components/ui/hooks/useProviderModelList.ts`（新增）：挂载时取缓存列表，手动点击时带 `refresh: true`；路由类 provider 的结果直接写入 react-query 缓存。
- `webview-ui/src/components/settings/ProviderModelActionsContext.ts`（新增）：由 `ApiOptions` 提供获取/保存动作，`ModelPicker` 在未显式传参时从 context 取——因此 20 处 ModelPicker 用法全部自动获得两个按钮。
- 静态目录 provider 的列表会与远端结果合并：已知 ID 保留内置元数据，新 ID 用 `openAiModelInfoSaneDefaults`。
- 按钮下方有一行状态：已获取 N 个 / 来自缓存（时间）/ 获取失败（原因）/ 无法获取改用内置列表；保存后短暂显示「已保存」。
- 自动获取逻辑（`ApiOptions` 的防抖 effect、`useRouterModels`）保持不变。

## 任务 5：对话框左右贴边

`ChatTextArea` 非编辑态的容器原为 `px-1.5 pb-1 w-[calc(100%-16px)] ml-auto mr-auto`——比父容器窄 16px 且居中，内部再各留 6px。改为占满宽度、去掉水平内边距与底部内边距；输入框与高亮层在非编辑态改为直角（贴边后圆角会在角上露缝）；`index.css` 的 `.octo-composer-grip` 同步改为整宽。编辑态（在消息内就地编辑）维持原样。

## 4 号机：oMLX 的 macOS app 入口

- `/Applications/oMLX.app`：官方 v0.7.0.dev2 正式包（dmg 的 sha256 与 release digest 一致，Developer ID 公证，Gatekeeper 通过）。
- `~/Library/Application Support/oMLX/base-path` 指向 `~/llmserver/servers/omlx/runtime`，app 与 LaunchDaemon 共用同一份 `settings.json`。
- 通过管理 API 把 `server.auto_start_on_launch` 置为 false：该标志开启时 app 会尝试自起服务、与 LaunchDaemon 抢 8000 端口并弹错。已核对 app 源码 `ServerProcess.swift`：端口冲突时它只报告，不会杀掉外部进程。
- `/Applications/oMLX 控制台.app`：AppleScript 启动器，先查 `/health`，再打开 `/admin/auto-login?key=…&redirect=/admin/dashboard`（实测 302 → dashboard 200）。

## 验证

- 扩展包完整测试：6006 通过 / 36 跳过（串行 `--pool=forks --fileParallelism=false`）。
- webview 完整测试：1525 通过（首轮 localeParity 失败 17 项，补齐 18 种语言的新文案后通过）。
- 类型检查、eslint：改动文件无新增问题，未新增 lint 抑制。
- 注意：`webview-ui/src/i18n/locales/*` 多数为 CRLF，prettier 期望 LF，属既有状态。
