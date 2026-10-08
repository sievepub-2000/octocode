# 下一版本修复日志：MCP provider 与共享 Hub 生命周期

日期：2026-10-08 UTC。源码修复，安装版尚未升级。

MCP manager 现在按 provider 保存唯一的待完成或活跃引用；最后一次释放后不会复用已关闭 Hub。同一 provider 并发获取不会重复计数，旧注册释放不会扣减新一代或匿名引用。共享 Hub 的 provider 引用交给仍活跃的所有者。初始化、清理及实例标识写入按捕获的对象串行，旧清理完成不会清空替换实例。

provider 释放后的迟到初始化/marketplace 回调不再接入 Hub。原同步 webview、监听器及 tracker 清理仍在 MCP await 之前；MCP 释放失败后，其余本地清理在 finally 中执行并保留错误。原匿名 register/unregister API、同步 void unregister API、启用默认值、权限、OAuth 和 stdio 请求规则均保持。

初始候选实际 18 项通过，但 MAIN 冷核发现同 provider 并发时多计引用：唯一所有者释放后仍有引用及一个真实子进程。原失败及精确子进程 finally 清理全部保留；候选经最小修正后，MAIN 对实际 Authority 的 18 项生命周期及 9 项并发/清理顺序控制全部通过，各 21 和 8 个所属 child code0/live0。发布范围候选也分别实际运行同样两组并通过。VSCode/provider/storage/显式调度使用适配，SDK、Node、stdin/stdout 与关闭是真实执行；不代表正常模型、真实 GUI、多窗口、存储持久化或其他平台验收。

永久测试位于 Core/src/services/mcp/__tests__/manager-lifetime 和 manager-same-provider-concurrency。以全新 owned 输出设置 OCTOCODE_STDIO_TEST_ROOT，按各 README 运行。完整 Source 前后、两阶段冻结、原 RED、MAIN 当前及发布候选结果见审计 mcp-manager-lifetime-main-20261008T2210。既存 Source provider handoff 分支保持原样，发布仅带本次已测试生命周期差异，其余历史分支未借本批验收。

完整 Core/src 编译通过；三文件既有 lint 数量仍为 Manager1、Hub10、provider4，新规则为零，不称整文件 lint clean。版本、标准安装程序、原位 Upgrade、真实生产日志/模型及全系统验收仍待完成；175117 独立保证合同 HOLD 不变。
