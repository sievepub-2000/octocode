# VM 回归测试的标准 Node 特性准入（2026-10-11，第三十二批）

补查标准 test-node 入口时确认，第三十一批的隔离 VM 回归需要 --experimental-vm-modules，但标准入口不启用该特性。默认 Node 的四个新测试实际失败，原失败和完整输出保留。第三十一批在明确启用特性的受控验证中通过的事实不变，也不替代默认入口验收。

仅在新 assertHeap.test.ts 的 suiteSetup 中检测 SourceTextModule；缺少特性时用 Mocha 的明确 skip 记录四个 pending，启用特性时继续执行四个完整回归。四个测试语句和实际 helper 未改，未改 runner、生产 flags、配置、依赖或检查抑制。修复后 Source/private 默认模式零失败、各四个明确跳过；启用特性时各四个通过，相关完整依赖 types 零诊断，直接 ESLint 零错误/警告。计数数据和普通 JS VM 控制不是实际 heap、inspector、WASM 或 Native 验收。

为在 Source 变更前收尾已启动的补审，MAIN 对本次 owner/root 及其实际子进程保有创建身份核验的句柄，使用既有 kill-on-Job-close 合同并逐一观察退出。该中断不是自然完成；原 RUN、报告、请求、attempt 和 metadata 保留，未知上游结果不推断，不增加原模型/请求/输出预算或重跑已闭同 SHA。仅发布本测试文件和本日志，未生产部署；其余历史审计、平台与最终原位 Upgrade 尚未完成。
