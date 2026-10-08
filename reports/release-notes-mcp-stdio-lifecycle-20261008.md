# 下一版本修复日志：MCP stdio 恢复生命周期

日期：2026-10-08 UTC。本批接入并修复此前未提交的stdio恢复分支，不修改Native权限或诊断合同。

关闭的stdio transport仅在新请求派发之前恢复；已经执行但丢失响应的请求不自动重放。恢复和连接的每个异步边界核对启用状态、connection对象、配置、global/project来源和实际项目路径。停用、删除、替换配置、切换项目或销毁后的旧流程不能继续启动或派发。原Windows路径比较函数保留大小写/尾分隔符的正常等价。

stderr/error/close回调只修改同一transport；删除只移除入口时捕获的connection对象，保留随后创建的新对象。失败的初始化与tools/list关闭该流程实际持有的client/transport，不泄漏child。设置consumer先完成mcpEnabled写入，再执行Hub lifecycle，避免停用读到旧true或启用读到旧false。

旧Source在36个场景中20个失败，不是20个独立漏洞。最终双文件候选及MAIN应用后的仓内永久测试36/36通过，56个owned Node child全部正常关闭，未知已执行请求没有重复。完整src类型检查零诊断；独立lint为Hub原10条错误不增、设置consumer0，不称Hub整文件lint通过。完整字节/11+2 literal hunks正逆、2504个冻结文件全hash由MAIN重新冷核。

运行方式：从Core设置 `OCTOCODE_STDIO_TEST_ROOT` 为新的owned输出目录，然后 `node src/services/mcp/__tests__/stdio-recovery/recovery-tests.cjs`。使用真实SDK1.31的stdin/stdout、实际Source类和无害JSON-RPC fixture；VS Code/provider状态、配置/provisioning和显式调度边界使用命名适配，协议流和child关闭有完整记录。

完整证据在 `owned/20261008-mcp-stdio-recovery-current-worker` 和MAIN `mcp-stdio-recovery-main-20261008T175633890271Z`。本批没有正常模型MCP write、真实UI/SecretStorage持久化、SSE/OAuth新运行、真实用户MCP或跨平台/安装验收；生产singleton/provider重用边界继续审计。既有OAuth guards和预算保留，ONLY117仍HOLD。
