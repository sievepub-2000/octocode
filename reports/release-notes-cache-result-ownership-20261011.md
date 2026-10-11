# CacheResult 释放只影响其拥有的缓存项

修复旧 `CacheResult` 再次 dispose 会清掉后来创建的缓存项的问题。每个 disposer 现在只在其结果对象仍拥有当前 slot 时清空该 slot；取消和释放仍针对该结果原有 CTS。判断使用结果对象身份，因为不同缓存项可以合法地返回同一个任务 Promise。任务原 Promise、协作取消、返回拒绝 Promise 的缓存合同，以及 LRU/WeakCachedFunction 和同步 task throw 清理都保留。

追加两例永久回归：替换项与旧项共享 Promise，以及真实 CancellationToken listener 同步创建替换项。原 Source 整 cache 模块加新提案只执行这两例时，两例都实际失败；修复后的实际 Source/private 依赖映射重新编译，各 6 个受影响 Cache 用例通过（4 既有 + 2 新增）。12 个原完整 test 语句保持，未重跑未变的 LRU/WeakKey 控制。

Source/private 两完整依赖各 1085 非声明、1516 总输入、1545 read，types 0；两个修改 TS 的 Source 配置直接 ESLint 0 errors/0 warnings。实际 private async.ts 独立差异被编译和测试，本批没有夹带该文件。原 120s + finally 30s Job、创建身份和收尾核验保持，Source 编译输出没有写入。

权威证据目录：D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/cache-result-ownership-source-repair-main-20261011T1955。MAIN CANDIDATE-COLD 全文核封存 241 普通文件（239 payload + 两 root envelopes）、97 目录 anchors 和 575 绑定、15 原 exact/report/proof/完整 closed session、实际 Source/consumer 与完整 literal 正逆。目录 anchors 不是 15 个意见或产品文件数。STANDARD-VERIFICATION 6a6bee04b643630f4a0cb4e34faa8667dd5715c1f6c9bfe57f667a7f82293696 核实际 6333 绑定及 red/green、types、lint和真实依赖映射。产品新 SHA be2d74e704b22291dfb8806aac2fbfd28d58ba411db95d9c6b1c482f673cfe29，测试新 SHA f8fdedf793d279c88543e9ed582aafa5c3e229fc69ded8e2ff399ff13759636f。

这是一个结果归属根因；两个回归不是两个独立漏洞，也不新增任务强制结算、吞错或初始化 single-flight 策略。原意见、类别变体、失败、报告、会话和之前各批验证保持。本批仅两个 TS 和本日志、正常 private master 发布，不改变组件 HEAD/staged entries 或其他用户 dirty；没有真实 heap、inspector、WASM、Native、MCP/EPIPE、GUI、installer 或生产执行。全历史审计、实机验收、E08/Native175117 和最终 Upgrade 尚未完成。
