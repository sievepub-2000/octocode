# assertHeap no-op 保留测试时限

修复 `assertHeap` 在没有 heap analyzer 时仍将当前测试 timeout 提升到 20 秒的问题。现有 analyzer guard 前移，无 analyzer 的合法正在运行测试调用直接返回，保留原 timeout；实际 analyzer 分支仍维持 20 秒最低值、调用时 classes 副本、提前分离 teardown batch 和 Promise.all 首错语义。

永久回归复用现有隔离 VM fixture，允许省略 analyzer，断言原 1000ms timeout 保持。四个既有完整 test 语句和 suite feature guard 保留。原 Source 整 helper 加新测试只运行此新增例时，实际出现 `20000 !== 1000`；修复后的实际 Source 与 private 依赖映射重新编译，启用既有 VM 特性各 5 例通过。默认 Node 各 5 例明确 pending、0 失败，与启用特性的通过结果分开。

Source/private 两完整依赖各 1087 非声明、1518 总输入、1547 read，types 0；两个修改 TS 的 Source 配置直接 ESLint 0 errors/0 warnings。所有验证使用原 120s + finally 30s Job、创建身份及收尾核验，没有扩大配置或预算；Source 编译输出目录没有写入。

权威证据目录：D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/assertheap-noop-timeout-source-repair-main-20261011T1930。MAIN CANDIDATE-COLD 全文核封存 200 普通文件（198 payload + 两 root envelopes、0 anchors）、551 绑定、6 原 exact/report/proof/closed session、完整 Source/consumer；STANDARD-VERIFICATION 62d5408d829d05aec97d8459b36f4b46677c0eec5fe0d810ebd7b0fa7fa7be3e 核实际 6293 绑定、原 red 和所有新验证结果。helper 新 SHA d6a36b3892b569d91ba6acaca6b2bd7d43551488272ba594994fa29af5340527，test 新 SHA fff9fef8c540187ecaa12d80d82ccdb51cf2d1f1cce3f4f445eeb94f311fc87c。

验证调用整编译 helper 并注入声明的 counts 数据，没有执行真实 heap、inspector、WASM、Native 或安装版 GUI。原报告、警告、失败 attempt 和 red 全部保留；这是一项测试 helper 缺陷修复，不代表全历史审计、真实平台验收、E08/Native175117 或生产 Upgrade 已完成。发布仅两个 TS 和本日志，组件 HEAD、staged entries 及其他用户 dirty 保持。
