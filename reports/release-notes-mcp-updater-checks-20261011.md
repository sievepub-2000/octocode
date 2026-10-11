# MCP 冒烟检查与安装器更新提示修复（第二十九批，2026-10-11）

MCP stdio 冒烟脚本改为解析完整 NDJSON 响应，并只接受已经发出的请求的精确数值 ID。初始化及工具列表分别核对 result/error 和 tools 数组，避免空白、相邻 ID、错误响应或无关 tools 文本造成错误结果。child/stdin/stdout/stderr 错误进入已有失败路径，直接子进程清理由 finally 执行。共享 15000ms 请求期限不变。

实际 Inno consumer 使用 UpdatingVisualStudioCode 这个既有消息键。13 个内置语言文件中该键的品牌文字统一改为 OctoCode，保留键名、各语言句式、其他字节和原有省略号。英文导出源与繁中等默认资源同时修正；没有新增格式参数。

验证：实际 Source 的 Node --check 退出0；Source MCP 全文件字节与已独立核回的候选933813c6完全一致，当前 Node 全文件哈希也与原五项真实 Windows stdio 控制绑定一致。因此复用原五个已成功控制，没有重跑同SHA成功用例。13个资源逐字节正反替换和现有 Inno/翻译导出消费者核对通过；这不表示已编译或运行安装器。

边界：唯一 EPIPE 试验没有观测到 EPIPE，原失败与清理记录保留，未重试。finally 的直接 child 观测不升级为 Windows 所有子孙自然退出或 Native175117 保证；原9个Job、15秒范围和 finally30约束保持。未执行生产升级、网络、模型、PNPM或整树安装。

本批只含一个MCP脚本、13个语言资源和此日志。组件HEAD及staged entries保留，只提交private aggregate master。

证据：D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/mcp-installer-source-repair-main-20261011T1214/；CANDIDATE-COLD.json、SOURCE-APPLIED.json、STANDARD-VERIFICATION.json及发布后的REMOTE-FRESHCLONE.json。原评论E05/E06/E08/E41逐条绑定原report/session/proof，部分建议中不成立的因果不会因源修复而改写。
