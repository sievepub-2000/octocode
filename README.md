# OctoCode

OctoCode 是面向 Windows 的 AI 编程桌面应用，将编辑器、项目与对话管理、模型接入、原生任务执行和 MCP 工具集成到同一工作台。用户可以让模型检索代码、修改文件、运行命令并检查结果；实际能力及访问范围取决于配置的模型、工具和权限。

## 下载与当前版本

当前桌面版本为 **1.132.4**，核心扩展版本为 **0.1.10**。

- [Windows x64 安装包](https://github.com/sievepub-2000/octocode/releases/download/v1.132.4/OctoCodeSetup-1.132.4.exe)
- [GitHub Release 与全部附件](https://github.com/sievepub-2000/octocode/releases/tag/v1.132.4)
- [本版更新说明](release/v1.132.4.md)及[发布与校验说明](release/README.md)

安装包约 1.05 GB，包含桌面程序、核心扩展、Host、harness 和配套运行环境；首次使用仍需配置自己的模型服务及凭据。模型费用由所选服务决定。本版本仅提供 Windows x64 安装包。

## 主要功能

- **项目与对话管理**：新项目拥有自己的目录，新对话拥有独立执行目录。草稿、终端、附件和产物预览关联所属对话；运行时检查任务工作目录。
- **代码与任务执行**：原生 harness 负责代码检索、文件操作、命令及工具调用，支持会话检查点、上下文压缩和任务接续。
- **模型接入**：使用应用中的提供商配置或兼容网关接入模型；GLM5.3 已通过本版的独立 headless 验收回测。
- **MCP 工具**：支持 MCP 配置与调用，发行环境包含代码审查等工具；部分可选工具需另外配置。
- **命令行自动化**：harness 支持 `--single`、`--model` 和 JSON 输出，Host 使用本地 stdin/stdout JSON RPC。本版没有公开的 HTTP 桌面控制接口。

目录隔离用于避免状态误复用，不构成操作系统级安全沙箱；绝对路径访问及权限绕过模式仍受所授予权限影响。已有会话保留原目录，迁移需显式执行。

## 安装与开始使用

1. 下载 Release 中的 `OctoCodeSetup-1.132.4.exe`，按 [SHA256SUMS](release/SHA256SUMS) 校验。
2. 保存任务并关闭 OctoCode，运行安装器。系统级安装需要管理员权限；默认目录是 `D:\Program Files\OctoCode`，向导可选择其他目录。
3. 在应用中配置模型服务地址、模型与 API 凭据，再创建项目和对话。凭据应通过应用导入，不要提交到 Git 仓库。
4. 安装后可用 PowerShell 执行自检：

```powershell
pwsh -NoProfile -File 'D:\Program Files\OctoCode\test\self-test.ps1'
```

默认安装路径下的 `data`、`workspace`、`environments` 联接至 `D:\gpt-workspace\octocode\runtime`；其他自选路径使用本地目录。升级通过新版安装器原位覆盖并保留用户状态。卸载移除程序和联接，保留外部数据；不要递归跟随联接删除项目或凭据。在线更新服务尚未部署，请从 GitHub Releases 下载新版后手动升级。

## 代码结构

- `desktop-shell/`：桌面编辑器、工作台和安装器。
- `octo-harness/`：原生任务执行器及命令行服务。
- `octocode-core/`：核心扩展、提供商集成、Webview、Rust Host 与数据接口。
- `maintenance/`：升级与保留检查；`reports/`：审查验收证据；`release/`：版本说明、下载入口和校验清单。
- 根目录脚本组装以上组件并执行 Windows 构建、安装及验收。

源树独立开发后导出到此仓库，不包含构建输出、运行数据、缓存、凭据或嵌套 Git 元数据。

## 构建与验证

Windows 构建和维护流程见 [安装与构建文档](WINDOWS-INSTALL-UPDATE.md)。Windows 检出前建议启用长路径：

```powershell
git config --global core.longpaths true
git clone https://github.com/sievepub-2000/octocode.git
```

本版完成本机 Windows 原生卸载后重装、内置自检、冷启动及 Host API 生命周期与项目/会话隔离测试。源码测试 6,182 项通过、25 项跳过、0 项失败。详细证据与限制见 [验收报告](reports/release-acceptance-0.1.10-20261013.md)。桌面 UI 操作、Linux/macOS/Docker 和在线更新未完成端到端验收。

## 许可证与来源

OctoCode 集成并改造多个开源组件，不宣称全部代码为原创。各组件保留其许可证和第三方版权说明；分发前请阅读 `desktop-shell/`、`octo-harness/`、`octocode-core/` 内的许可证及 notices。
