# 下一版本修复日志：Git、命令解析和文档解析依赖

日期：2026-10-08。源码依赖修复，安装版尚未升级。

核心扩展更新 simple-git 4.0.2、argv-parser 2.0.1、args-pathspec 1.0.4、shell-quote 1.12.0、proxy-addr 2.0.8、xmldom 0.8.15。低版本的三项传递依赖使用版本范围限定的 workspace override；移除旧 xmldom 的 deprecated 例外。simple-git 4.x 使用命名导出，checkpoint 仅相应调整 import，现有 Git 环境过滤、空模板约束与权限保持原样。

已在独占临时目录真实复现旧 simple-git 的 trailer 配置守卫绕过，仅写无害本地标记并在 finally 清理。升级后普通危险配置控制与 trailer 配置均被库的 GitPluginError 拒绝，未放宽 unsafe 选项。该测试证明依赖守卫行为，不宣称真实产品接收了攻击者配置。

验证：101 项 checkpoint/命令解析测试、117 项 MCP/文本提取测试、完整扩展 src 的 tsc --noEmit 通过。实际兼容测试核 IPv4-mapped IPv6 不错误信任其他 IPv4、合法子网行为、96 MB/4秒边界内的 XML namespace 解析、Mammoth 深层 DOM import、正常 DOCX raw text及损坏文档拒绝六项。未改变实际 MCP 的 localhost、trust proxy=false或 token 授权规则，未使用真实用户文档。

原 default import 引起的升级兼容失败、GitPluginError 构造函数名被压缩而造成的检查器误判、错误工具路径等失败完整保留。修复 named import、采用真实导出类型检查后通过；不以标记未出现单独证明守卫或全部进程权限。

本日志仅涵盖核心依赖分组；桌面与独立测试/remote/build 的其他锁、微软 russh fork、其余安全告警、打包 SBOM、真实运行与安装验收仍继续核查。

来源：[simple-git 公告](https://github.com/advisories/GHSA-x6jw-m9v5-85vh)、[proxy-addr 公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)、[xmldom 公告](https://github.com/advisories/GHSA-965w-775f-mr7g)。
