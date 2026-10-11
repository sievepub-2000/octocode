# Cache、取消池与测试 helper 契约修复（2026-10-11，第三十一批）

取消池释放后停止接收新 token；注册监听期间同步取消时，使用已有 Event.once 保留事件和返回的监听归属。Cache 任务同步抛错时取消并释放本次 token source，再保留原错误；返回的拒绝 Promise 仍按既有缓存合同处理。WeakCachedFunction 在调用值函数前校验弱 key，保留对象、函数、非注册 symbol 及自定义 primitive 参数到合法弱 key 的接口。

assertHeap 在 teardown 开始时移出本批队列，失败不会将本批带入后续 teardown，并在调用时复制 classes 映射，保持名称和断言对应。保留 20 秒最低测试时限和 Promise.all 首错语义。MCP 失败诊断在 stderr 只有空白时使用原完整 stdout，保留有内容的 stderr、完整 NDJSON/tools 输出和原共享 15000ms 期限，不新增输出裁切上限。

新增永久回归：取消池四例、WeakCachedFunction 四例、Cache 同步失败一例、隔离 counts 数据的 heap helper 四例。MAIN 全文冷核两个新封存包的 321/75 个物理文件，逐段组合重叠候选，保留原测试语句和第三十批文档修正。证据根为 D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/w41-contract-source-repair-main-20261011T1317/combined-r2。

实际 Source 与 private 依赖映射各 1088 个非声明文件、1519 个总输入类型检查零诊断；直接 ESLint 六个 TS 文件零错误/警告，MCP Node --check 通过。两套实际 Source/private 依赖的 Mocha 回归各 24 个不同用例取得成功结果：首轮 24 个断言通过，但新 Cache 测试清理钩子失败；修复测试自己返回的监听归属后，只重跑该一例通过，其余 23 个成功用例未重跑。原类型、lint、清理钩子失败和准备期 CommonJS 发射副本完整保留。

heap 验证重新编译当前完整 helper，通过既有 Node --experimental-vm-modules 和隔离 SourceTextModule 注入声明的计数数据；VM Modules 的实验特性提示完整保留。本次没有实际 heap snapshot、inspector、WASM、Native 或安装版 GUI 验收，没有改 runner/config 或抑制检查。MCP 三个诊断数据用例通过，没有重跑原五个真实 stdio 控制或唯一未观测到 EPIPE 的尝试；诊断修复不证明输出内存上界、Windows wrapper 子孙退出保证或 Native175117。

发布仅包含四个产品/helper 文件、三个永久测试和本日志，private 独立 async 等依赖差异未夹带。组件 HEAD 和已有 staged entries 保持，未丢弃用户 dirty。本批不是全部历史意见、完整生产或平台验收；最终 installer 与原位 Upgrade 尚未执行。
