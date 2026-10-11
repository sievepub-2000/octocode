# assertHeap 错误诊断、调用归属与提前拒绝观察

修复公开测试 helper 的三个具体问题：断言失败的包装错误保留原 cause，null/undefined/string 抛值仍带 class/count/test/file 上下文；调用前冻结测试标题，provider await 后继续使用同一标题；立即观察返回的原 done Promise 的提前拒绝，队列仍保存该原 Promise，teardown 继续报告原错误。

不增加清理 hook、聚合错误、timer 或运行预算。浏览器无 analyzer 的 no-op、活动测试 20_000 ms 最低值、独立 teardown 时限、调用时 classes 副本、splice 分离当前批次与 Promise.all 首错语义保持。

新增三例永久回归，通过隔离 VM 执行新编译的完整 helper。原完整 helper 配合新增提案实际三例失败，分别复现 cause 丢失、counts 提前拒绝事件和标题错归属。首 lint 因新测试的 in 运算符警告失败；仅改新 cause 检查为 Object.hasOwn/Reflect.get，完整旧 helper 配合最终 cause 回归仍失败。原失败输出保留，五个原完整 test 调用语句不变。

最终实际 Source 与 private 依赖分别新编译：启用既有 --experimental-vm-modules 特性，各 8 例通过、零未预期错误；默认入口受既有特性 guard 限制，各 8 例 pending、零失败。两套完整依赖类型检查各 1087 非声明 / 1518 总输入 / 1547 读取绑定、零诊断；实际已装 ESLint 对两 TS 直接运行，零错误、零警告。全部命令沿用原 120 秒 + finally 30 秒 Job 边界及创建身份清理核验。

标题回归使用声明的 setup 身份更替数据，没有执行真实 Mocha 超时；counts 为声明的合成数据。没有真实 heap、inspector、WASM、Native、安装版 GUI 或生产执行，没有 Source out 写入。这些验证不完成全产品、Native175117、E08、全历史意见或最终 Upgrade 接受。

实际证据根：D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/assertheap-diagnostics-label-rejection-source-repair-main-20261011T2112。CANDIDATE-COLD.json SHA256 117a702e0432e4ce16e15b57b0827d74fb0c5e35e1fae7ebfa10202a4c0d8b1e；STANDARD-VERIFICATION.json SHA256 89b501059c7453cf203a62c265977ae7be62b7bf4e3d8c250cb006ea17e7e990。产品完整 SHA256 ece516d40530037b77132ea7aa5f68f5088b107383b621d3f8ea80341904593a；测试完整 SHA256 0317600a99ea2a4605dbec061ea9fe2145e095165b18d62a0f36c471af542b15。

仅这两 TS 与本日志进入 private master。组件 HEAD、全部 staged entries 和其它用户 dirty 保持；未 component commit/push、未生产部署。全部原报告、会话、proof、失败与旧候选保留。
