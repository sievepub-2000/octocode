# OctoCode 发布目录

本目录保存版本说明、发布清单和 SHA-256 校验值。安装包作为 GitHub Release 附件分发。

- [已发布的 GitHub Releases](https://github.com/sievepub-2000/octocode/releases)
- [2.0.5 更新说明](v2.0.5.md)：默认工作区、PS7 代理终端、账户入口、关于版本与展示窗口修复，见[发布记录](../reports/v2.0.5-release.md)。
- [2.0.4 更新说明](v2.0.4.md)：六项依赖告警修复、作者与双授权、内嵌离线手册，见[发布记录](../reports/v2.0.4-release.md)。
- [2.0.3 更新说明](v2.0.3.md)：系统更新退出交接修复，范围见[发布记录](../reports/v2.0.3-release.md)。
- [2.0.2 更新说明](v2.0.2.md)：交换浅色配色并默认 Light，实际在线升级状态见[报告](../reports/v2.0.2-acceptance.md)。
- [2.0.1 更新说明](v2.0.1.md)：桌面内部版本 2.0.1、核心扩展 0.1.14，验收状态见[报告](../reports/v2.0.1-acceptance.md)。
- 1.132.4 在发布前因 215 项依赖告警中止，未创建对应 GitHub Release；旧校验清单仅记录当时的本机构建，不能视为已发布附件。

下载后在 PowerShell 中校验：

```powershell
Get-FileHash -LiteralPath '.\OctoCodeSetup.exe' -Algorithm SHA256
```

本目录 `SHA256SUMS` 对应 2.0.5 的签名资产；文件匹配不代表所有功能已经自动验收。
版本使用 Release 附件 `octocode-release.json` 记录安装包及 VSIX 的哈希、大小与版本，
`octocode-release.json.sig` 提供固化公钥验证的 Ed25519 签名。安装前保存任务并关闭 OctoCode；已有安装使用原位升级。

发布采用版本标签、GitHub Release、版本说明与附件。自动附加的 Source code ZIP/TAR 是源代码，安装时请下载 EXE。GitHub Release 发布不代表应用内在线更新服务已经上线。
