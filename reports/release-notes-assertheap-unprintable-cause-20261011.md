# assertHeap 不可打印断言原因的上下文保全

修复完整当前 helper 中一个相关诊断问题：合法断言回调抛出普通 Object.create(null) 对象时，原 String(e) 会先产生 TypeError，覆盖原断言原因并丢失 class/test/file 上下文。仅保护 detail 的取值与字符串转换，转换失败使用固定可打印文字，随后仍构造同一上下文 Error 并以 cause 持有原抛值。

正常可打印 Error/message 和非 Error 的诊断文字保持；原 done Promise 身份、提前拒绝观察、Promise.all 首错、classes 长度检查、批次 splice、调用时标题/classes 副本、当前测试 20_000 ms 最低值与独立 hook 时限保持。未采用 C37-001 的 allSettled/聚合建议，也未创造第七条模型意见；修复来自该意见引用窗口的独立完整上下文核验。

新增一例永久回归抛出无自定义 getter 或转换方法的普通无原型对象，检查原 cause 身份和 class/test/file 上下文。原 8 个完整 test 调用语句及既有 VM 特性 guard 保持。完整旧 helper 配合仅新增一例实际失败，得到 TypeError: Cannot convert object to primitive value；原 RED 完整保留。

最终 Source/private 分别使用实际完整依赖新编译：启用既有 --experimental-vm-modules 特性，各 9 例通过、零未预期错误；默认各 9 例 pending、零失败。两完整类型闭包各 1087 非声明 / 1518 总输入 / 1547 读取绑定、零诊断；实际已装 ESLint 对两 TS 直接运行，零错误、零警告。原 120 秒 + finally 30 秒 Job 边界、创建身份及 cleanup 核验保持。

实际证据根：D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/assertheap-unprintable-cause-source-repair-main-20261011T2228。CANDIDATE-COLD.json SHA256 3df4a8ddd8e62517488ea16a138dcfed31f851ac5d59a74c547770eb100444ec；STANDARD-VERIFICATION.json SHA256 aae0d826b4fc9b946ebaa51f788ee0bb5c7c6e468298e819c7c098e7d2c6378d。产品完整 SHA256 32d69f4a8c180553c82622c0266a48832eda534c743d9db6aadeac6c2807012f；测试完整 SHA256 c816b7432a66dac8f124fd21d0e0dafbc97fc430f2007feba211501c8f315293。

验证为隔离 VM 读取实际整编译 helper、注入声明的 counts 数据；没有真实 heap、inspector、WASM、Native、安装版 GUI、实际 Mocha 超时或生产执行，没有 Source out 写入。不升级为全历史、平台、权限、Native175117、E08 或最终 Upgrade 接受。

仅两 TS 和本日志进入 private master；组件 HEAD、全部 staged entries 与其他用户 dirty 保持，未 component commit/push、未生产部署。原 comment/report/session/proof/失败/候选全部保留。
