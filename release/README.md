# OctoCode 发布目录

本目录保存版本说明、发布清单和 SHA-256 校验值。安装包作为 GitHub Release 附件分发。

- [当前发行版 v1.132.4](https://github.com/sievepub-2000/octocode/releases/tag/v1.132.4)：桌面 1.132.4、核心扩展 0.1.10。
- [Windows x64 安装包](https://github.com/sievepub-2000/octocode/releases/download/v1.132.4/OctoCodeSetup-1.132.4.exe)
- [更新说明](v1.132.4.md)、[校验值](SHA256SUMS)、[机器可读清单](manifest.json)

下载后在 PowerShell 中校验：

```powershell
Get-FileHash -LiteralPath '.\OctoCodeSetup-1.132.4.exe' -Algorithm SHA256
```

结果应为 `53607C4B929B3F65D38331C2D1625372DB6B4D45894BA8D80BB205723E3511F6`，大小为 1,045,435,971 字节。安装前保存任务并关闭 OctoCode；已有安装使用原位升级。

发布采用版本标签、GitHub Release、版本说明与附件。自动附加的 Source code ZIP/TAR 是源代码，安装时请下载 EXE。GitHub Release 发布不代表应用内在线更新服务已经上线。
