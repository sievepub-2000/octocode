# OpenRouter 免费编码模型实测

日期：2026-10-28。用户要求：总参数量严格超过 50B、输入和输出价格均为零，实际生成速度超过 20 tokens/s 才保留。
MoE 按总参数量计，不把激活参数量误当作总权重规模。

## 方法与结果

直接读取当日 [OpenRouter 模型目录](https://openrouter.ai/api/v1/models)，选出 6 个符合参数和免费条件、支持文本输出及工具的模型。
每个模型执行三类真实流式 Python 编码请求：区间合并、稳定拓扑排序、事件规范化。
只请求明确的 `:free` 型号，路由输入和输出价格上限均设为零，并核对返回 usage 中实际 cost 为零。
测速请求关闭可选推理；开启推理后的首字延迟和可见速度不由这些数字保证。

速度使用返回的可见 completion tokens（扣除 reasoning tokens）除以首个至末个可见内容帧的时间，取三轮中位数。
同时记录首字延迟和含请求等待的端到端速度。生成代码完成且语法可解析才计入有效轮次；没有执行模型生成代码，不据此声称全面编程能力评测通过。

| 保留模型 | 总参数量 | 生成速度中位数 tokens/s | 含等待的端到端速度中位数 tokens/s | 首字延迟中位数秒 |
| --- | ---: | ---: | ---: | ---: |
| [Nemotron 3.5 Super VL](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free) | 120B | 114.593 | 97.253 | 1.649 |
| [Dots3-Note Preview](https://openrouter.ai/dots-studio/dots-3-note-preview:free) | 280B | 92.542 | 69.706 | 2.112 |
| [Laguna S 2.1](https://openrouter.ai/poolside/laguna-s-2.1:free) | 118B | 50.208 | 43.665 | 2.714 |
| [Nemotron 3 Ultra](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free) | 550B | 45.840 | 39.575 | 2.460 |

上述四个模型的所有三个有效轮次均超过 20 tokens/s。Laguna 首轮遭遇 429 限流，退避后取得三轮有效结果，没有把限流请求记成速度通过。
四个模型的端到端速度中位数也超过 20 tokens/s，全部有效测速请求的返回费用均为零。
Thinking Machines Inkling Small（276B）和 Inkling（975B）返回 403，明确要求受认可的 agentic harness；未伪装成其他应用或绕过限制，未保留为可用模型，也没有将拒绝归类成低速。

## 配置处理

候选配置先写入正式安装的加密 profile 存储，再按实测结果筛选并解密读回核对。
现保留四个达标的免费配置；旧 `nemotron-3.5-lightning-free` 为 30B，按参数门槛删除而不发起测试。
付费 OpenRouter 及其他厂商配置保持原值。删除仅涉及模型配置，没有删除历史对话、项目或文件。
修改前已在正式安装的受保护存储目录创建加密数据库备份。密钥未写入源码、此报告或测试结果。

免费额度、排队和提供商性能会变化；这些数字是本次测量，不保证以后始终超过门槛。
四个保留模型也已通过 E 盘现有 OctoCode 的原生 Host/harness 只读任务：实际调用 `read_file`，读回独立文件内未在提示中提供的随机 nonce，并正确返回 20 条记录的合计 630。
逐项完成状态均为成功，任务耗时约为 Nemotron Ultra 27 秒、Super VL 15 秒、Dots3-Note 19 秒、Laguna 72 秒；后者首次出现提供商错误，重试后完成，不能据其生成速度保证排队或首字延迟。
这项验收使用已安装的 2.0.0 / 0.1.13 执行链；2.0.1 升级后的实际 profile 加载继续记录在 [2.0.1 验收报告](v2.0.1-acceptance.md)。
