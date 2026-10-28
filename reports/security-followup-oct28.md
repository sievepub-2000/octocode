# 2.0.1 发布前依赖复扫

2026-10-28。源码首次推送 `393f804a` 后，GitHub 开放告警由旧依赖图的 262 条降至 8 条。
下列 8 条告警对应 3 类依赖；未通过关闭漏洞告警或手工忽略来消除结果。

| 依赖 | 修复 | 验证 |
| --- | --- | --- |
| qs（4 条） | 核心、桌面、构建与 MCP 锁文件精确固定为 6.16.1 | 旧版复现异常，新版 6 个恶意输入与普通序列化通过；实际开发依赖副本逐文件校验；新扩展包包含旧包没有的 `toCoercible` 防护 |
| deepmerge（2 条） | 使用有来源与 MIT 许可的本地 `@octocode/deepmerge-security`，保留 4.3.1 API，安全创建目标自身数据属性 | 上游原型污染先复现，修复后 CJS/UMD 共 6 项测试通过，覆盖 null 原型、嵌套、数组、符号与自定义选项 |
| LiteLLM（2 条） | 可选 bridge 声明从 1.95.0 更新到修复版本 1.100.4，并同步随包环境声明 | 当前运行环境未安装 LiteLLM；未擅自安装可选代理服务 |

deepmerge 官方尚未提供修复版本，因此保留完整来源、原始归档完整性、许可证与本地补丁说明，
不冒称官方已发布安全版本。两处源码副本的修复入口一致，运行
`node --test vendor/deepmerge/security.test.cjs` 可复核。

桌面生产 `node_modules` 不包含 qs/deepmerge，但 qs 会被 MCP 依赖打入扩展的单文件代码。
因此本轮重新编译扩展、验证编译防护标记，再重新生成签名安装包；仅改清单不作为运行时修复。

核心、桌面、构建工具和 MCP 的完整注册表依赖审计均返回零漏洞。
GitHub 在后续主分支推送后的实时复扫结果、最终资产摘要和实际升级结果继续记录在
[发布验收记录](v2.0.1-acceptance.md)；本记录不代表尚未执行的在线升级已经完成。

来源：[qs 安全公告](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)、
[deepmerge 安全公告](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)、
[LiteLLM 权限提升公告](https://github.com/advisories/GHSA-7hp6-4w63-5g45)、
[LiteLLM SSRF 公告](https://github.com/advisories/GHSA-3cv6-jpf6-8222)。
