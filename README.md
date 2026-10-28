# OctoCode

当前待验收版本：桌面 **2.0.1**，核心扩展 **0.1.14**。
更新内容及验收要求见 [2.0.1 更新说明](release/v2.0.1.md)。

OctoCode 是面向 Windows 的 AI 编程桌面应用，将编辑器、项目与对话管理、模型接入、原生任务执行和 MCP 工具集成到同一工作台。用户可以让模型检索代码、修改文件、运行命令并检查结果；实际能力及访问范围取决于配置的模型、工具和权限。

## 下载与当前版本

当前安全修复候选版为 **2.0.1**（核心扩展 **0.1.14**）。真实安装、长对话、在线升级及 GitHub 默认分支漏洞复扫完成前，不宣布发布验收通过。

- [已发布的 GitHub Releases](https://github.com/sievepub-2000/octocode/releases)
- [2.0.1 更新说明](release/v2.0.1.md)及[发布与校验说明](release/README.md)
- [免费编码模型实测](reports/openrouter-free-models-oct28.md)：超过 50B 的候选、实际速度、工具调用及筛选限制。

当前候选安装包约 740 MiB，包含桌面程序、核心扩展、Host、harness 和配套运行环境；首次使用仍需配置自己的模型服务及凭据。模型费用由所选服务决定。本版本仅提供 Windows x64 安装包。

## 主要功能

- **项目与对话管理**：新项目拥有自己的目录，新对话拥有独立执行目录。草稿、终端、附件和产物预览关联所属对话；运行时检查任务工作目录。
- **代码与任务执行**：原生 harness 负责代码检索、文件操作、命令及工具调用，支持会话检查点、上下文压缩和任务接续。
- **模型接入**：使用应用中的提供商配置或兼容网关接入模型；可通过 headless 接口让 GLM5.3 等模型运行工具并回测。
- **MCP 工具**：支持 MCP 配置与调用，发行环境包含代码审查等工具；部分可选工具需另外配置。
- **组件市场**：插件、Skills、MCP、运行环境共用市场入口和操作流程，每页最多 20 项，底部显示分页。Skills 接入 Agentic Awesome Skills 的 GitHub 目录，支持检索和按固定提交安装；慢网时明确显示随包快照来源。已安装组件优先，其他类别按来源热度排列。
- **项目代码索引**：在设置的“记忆和知识库”管理索引并搜索当前项目；原生索引提供离线符号和文本检索，也可配置嵌入服务使用语义检索。
- **界面与历史**：High Contrast Light 使用纯白底色，Dark 使用黑底、炭灰与铜棕色强调；回答、思考和执行的居中时间标签精确到秒。
- **命令行自动化**：harness 支持 `--single`、`--model` 和 JSON 输出；多个编辑器窗口通过经过认证的本地管道共享一个 Host。Host 使用 stdin/stdout JSON RPC，不对外开放 HTTP 桌面控制端口。

目录隔离用于避免状态误复用，不构成操作系统级安全沙箱；绝对路径访问及权限绕过模式仍受所授予权限影响。已有会话保留原目录，迁移需显式执行。

## 安装与开始使用

1. 下载已发布 Release 的 Windows x64 EXE，并按该 Release 附件中的 `octocode-release.json` 校验 SHA-256 和大小；应用内升级还会验证其 Ed25519 签名。候选版不作为稳定安装包分发。
2. 保存任务并关闭 OctoCode，运行安装器。系统级安装需要管理员权限；默认目录是 `E:\Program Files\octocode`，向导可选择其他目录。
3. 在应用中配置模型服务地址、模型与 API 凭据，再创建项目和对话。凭据应通过应用导入，不要提交到 Git 仓库。
4. 安装后可用 PowerShell 执行自检：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\Program Files\octocode\test\self-test.ps1'
```

正式安装、用户数据、工作区、运行环境和安装验收均位于 `E:\Program Files\octocode`，三个数据目录使用真实目录，不再链接到 D 盘。D 盘仅用于源码与开发构建。升级通过新版安装器原位覆盖并保留用户状态；卸载保留非空用户数据目录。不要跟随旧版联接删除项目或凭据。在线更新验收完成前，请从 GitHub Releases 下载已验证安装包后升级。

## 代码结构

- `desktop-shell/`：桌面编辑器、工作台和安装器。
- `octo-harness/`：原生任务执行器及命令行服务。
- `octocode-core/`：核心扩展、提供商集成、Webview、Rust Host 与数据接口。
- `maintenance/`：升级与保留检查；`reports/`：审查验收证据；`release/`：版本说明、下载入口和校验清单。
- 根目录脚本组装以上组件并执行 Windows 构建、安装及验收。

源树独立开发后导出到此仓库，不包含构建输出、运行数据、缓存、凭据或嵌套 Git 元数据。

GitHub 仓库只保留现有主分支 `master`。经过验证的改动统一合入并推送此主分支，不创建开发、修复或发布分支；发布版本使用标签。

## 构建与验证

Windows 构建和维护流程见 [安装与构建文档](WINDOWS-INSTALL-UPDATE.md)。Windows 检出前建议启用长路径：

```powershell
git config --global core.longpaths true
git clone https://github.com/sievepub-2000/octocode.git
```

2026-10-27 核心完整回归为 6,241 项通过、28 项条件跳过；10 月 28 日主题修正后的 Webview 全套为 1,636 项通过，另有 9 个浏览器主题渲染用例通过。High Contrast Dark 保留原紫灰／品牌红配色，普通 Dark 黑底／棕铜配色不变。前一安装版已实际验证双主题、原生 PowerShell 和 GLM5.3 同会话错误恢复；主题修正版仍须完成新的安装和界面验收。详细范围见 [2.0 项目报告](reports/PROJECT-STATUS-2.0.md)。本次只分发 Windows x64 桌面程序；其他平台未执行的安装生命周期不计为通过。

## 本机 API

运行中的客户端提供仅监听 `127.0.0.1:8765` 的认证 API，可创建任务、查询结果、订阅事件和继续同一会话；不需要桌面鼠标控制或另行部署服务端。令牌保存在正式安装的数据目录中，调用方在内存中读取，勿提交到仓库。

```powershell
$token = (Get-Content -Raw 'E:\Program Files\octocode\data\user-data\User\globalStorage\octocode.octocode\daemon\api-token').Trim()
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod 'http://127.0.0.1:8765/health'
Invoke-RestMethod 'http://127.0.0.1:8765/v1/runs' -Headers $headers
```

`POST /v1/runs` 创建或续接任务，`GET /v1/runs/{run_id}` 读取结果，`GET /v1/runs/{run_id}/events` 返回 SSE 事件。工作目录和权限必须明确符合任务范围。`/health.ok` 表示守护程序、执行器和调度器就绪；还应检查 `default_model_available` 与 `explicit_model_required`。没有兼容的默认模型时，可在任务请求中显式提供模型，未提供则返回校验错误。模型错误保留在结果的 `error` 中；失败后以原 `session_id` 和 `resume: true` 继续，不必新建对话。

## 许可证与来源

2026-10-27 推送前 GitHub 实际返回 261 条未关闭 Dependabot 告警。五套 Rust 锁文件、桌面全部 59 套 npm 锁文件和核心依赖已重新审计；新发现的 zstd 内存安全问题已升级修复，未忽略告警。依赖版本、移除路径或源码补丁见[原修复清单](reports/security-dependencies-2.0.json)、[当前告警映射](reports/security-alert-map-20261027.json)、[本轮验收证据](reports/candidate-2.0-security/)和 [Rust 修复记录](reports/rust-dependency-security-20261025.md)。本地审计不代替主分支推送后的 GitHub 复扫。仓库状态见 [Dependabot](https://github.com/sievepub-2000/octocode/security/dependabot)。

OctoCode 集成并改造多个开源组件，不宣称全部代码为原创。各组件保留其许可证和第三方版权说明；分发前请阅读 `desktop-shell/`、`octo-harness/`、`octocode-core/` 内的许可证及 notices。
