# Runtime 会话交接的任务身份关联修复

日期：2026-10-09。已验证的源码修复，纳入下一次发布；本机安装版仍为 desktop 1.132.2、扩展 0.1.8。

旧交接请求在等待后端准备、启动或通知递送时，仅比较会话编号。若同一会话已换成新任务，较晚到达的 ready、started 或失败通知会覆盖当前任务选择，重复 started 还会追加重复的用户消息。

修复将来源会话与任务编号一起从实际 ChatView 请求传递到 extension dispatch 和 provider；回包携带来源与实际目标的完整身份。provider 在异步边界后重新比较入口、当前和来源身份；每个视图按自己的当前选择核验消息。ready 保留目标关联，匹配的 started 才切换。任务切换会清除旧关联，过期或重复消息不能覆盖新任务、修改其错误状态或重复追加消息。全域广播、正常任务启动、Native RPC 权限及原超时预算保持原合同。

验证记录位于 `audit/fresh-review-after-history-20261001/provider-handoff-client-main-20261009T004502212288Z`：MAIN 独立读回 189 份冻结交付及前一份 156 文件交付，验证五份产品源码的完整 literal 正逆与两个测试提案；独立候选的实际 TS 链 13 项、完整 React/jsdom 组件 7 项及重复/队列边界 4 项全部通过。

实际 Source 标准 Vitest 两套共 13 项通过：`ChatView.runtime.spec.tsx` 与 `ChatView.handoffIdentity.spec.tsx`。从 `octocode-core/src` 和 `octocode-core/webview-ui` 分别运行实际 `node_modules/typescript/bin/tsc6 --noEmit`，两个完整项目均零诊断。直接使用已安装 ESLint 对修改的 Core、UI、类型文件执行 `--prune-suppressions --max-warnings=0`，三个入口成功，抑制计数不增加。

在自动安装尝试结束后，绑定当前 modules 元数据与实际编译器字节，再执行一次相关标准测试和两个完整类型项目，仍为 13 项通过、两个零诊断。限定发布候选另外运行实际 TS 链 13 项与重复/队列边界 4 项，全部通过；其余六份源码/测试与 Authority 在显式 EOL 规范下逐字节相等。

最初的 PNPM exec lint 入口触发自动依赖安装并超时，原输出、引擎警告和实际超时记录保留；不将其记为 lint 或完整安装成功。解析库两份锁及内嵌 magicast 修复不随本批发布。

发布范围保留 provider 原有尚未独立验收的 Native 清理差异。真实 VS Code transport、Native/SQL、正常模型、用户任务、产品 GUI、平台、安装、持久化及权限验收仍待执行。本批不解除原 175117 诊断保证变更的独立 HOLD，不代表全仓审计或生产升级完成。
