# oMLX 官方依据修复记录

日期：2026-09-15

## 执行结果

已按 Jundot/oMLX 官方 issue #3220 的 workaround 对 4 号机执行：

1. 备份 `runtime/model_settings.json` 到 `runtime/backups/mtp-official-workaround-20260915/model_settings.json.before`。
2. 仅将 `qwen38-flash-next` 的 `mtp_enabled` 改为 `false`。
3. 终止旧 oMLX 进程，由 launchd 自动重新拉起并重新加载模型。
4. 保留 PLE、缓存、chunked prefill、内存保护和其他实验性参数不变。

官方依据：

- https://github.com/jundot/omlx/issues/3220 明确记录 Jundot Qwen3.8-Flash-Next-oQ4e-mtp 在 Lightning MTP 下的故障，并给出关闭 Lightning MTP 后重载的 workaround。
- https://github.com/jundot/omlx/releases/tag/v0.7.0.dev2 明确说明 Qwen3.8-Flash-Next 属于 `qwen4_exp`，并支持结构化工具调用；因此 `qwen4_exp` 不是误配置。
- https://github.com/jundot/omlx/issues/1472 说明当前 OpenAI tools-only 请求不会自动安装 xgrammar 约束，工具名和 XML 结构依赖模型生成后的解析，xgrammar 已安装并不能单独修复此链路。

## 实测验证

- oMLX 版本：0.7.0.dev2；监听 `0.0.0.0:8000`。
- 当前进程已重新拉起，模型加载成功。
- `mtp_enabled=false` 已回读确认。
- `qwen38-flash-next:instruct` 普通请求返回 `OK`，HTTP 200。
- 同一服务的 `tools` 请求仍未返回 `message.tool_calls`：
  - 强制指定工具时返回普通文本或非法工具标记；
  - 自动选择工具时返回解释性普通文本；
  - 日志仍确认 parser 为 `qwen3_coder`，但没有结构化工具调用。

## 结论

MTP 兼容性问题已按官方 workaround 处理，但它不是当前 tools 失败的唯一原因。当前剩余阻塞点是：模型未稳定生成官方模板要求的完整 XML 包络，而 oMLX tools-only 路径没有 grammar-constrained decoding 来强制输出格式。官方 chat template 与本地文件已逐字校验一致，不能通过猜测修改模板解决。

当前状态：普通对话可用；OctoCode Agent 工具调用仍未通过验收。不能宣称整套 Agent 已修复。

## 下一步的官方边界

只有以下两条稳妥路径：

1. 使用 oMLX 官方后续版本中明确修复 tools grammar/该 checkpoint 工具调用的版本，并按其发布说明升级后重复固定 `echo_test(message=hello)` 验收；或
2. 为 Agent 选择官方明确验证过工具调用的 checkpoint，保留当前 Qwen3.8 作为普通对话模型。

不执行以下未经官方支持的操作：手工补闭合 XML、把普通文本强转为工具调用、启用全部实验性参数、修改 safetensors 权重。
