# OctoCode

当前发布版本：桌面 **2.0.4**，核心扩展 **0.1.16**。
更新内容及验证范围见 [2.0.4 更新说明](release/v2.0.4.md)。

## 作者、授权与完整手册

此项目由 **zillafan80@gmail.com** 独立完成，有合作需要请联系作者 **zillafan80@gmail.com / 479729980@qq.com**。

独立完成指 OctoCode 产品的独立开发、集成与维护；项目集成第三方开源组件，不宣称第三方作品为作者原创。作者有权授权的 OctoCode 自有内容实行双授权：个人非商业学习、自用免费；企业内部使用、受雇工作、收费服务、客户项目及商业集成等须取得作者书面授权。完整范围以 [LICENSE](LICENSE) 和 [商业授权说明](LICENSE-COMMERCIAL.md) 为准。商业限制不是 OSI 开源许可证，也不改变第三方 MIT、Apache 等既有授权。见 [第三方许可与来源](THIRD_PARTY_NOTICES.md)。

[详细中文使用手册](docs/USER_GUIDE.zh-CN.md) 包含安装、模型配置、项目与任务、权限、市场、知识库、主题、更新和故障排查。客户端“设置 → 关于”内嵌完整授权协议、第三方许可全文与使用手册，断网也可展开阅读。

OctoCode 是面向 Windows 的 AI 编程桌面应用，将编辑器、项目与对话管理、模型接入、原生任务执行和 MCP 工具集成到同一工作台。用户可以让模型检索代码、修改文件、运行命令并检查结果；实际能力及访问范围取决于配置的模型、工具和权限。

## 下载与当前版本

当前版本为 **2.0.4**（核心扩展 **0.1.16**），修复本轮六项依赖告警，并新增作者、授权与离线手册。验证范围见[发布记录](reports/v2.0.4-release.md)。

- [已发布的 GitHub Releases](https://github.com/sievepub-2000/octocode/releases)
- [下载 2.0.4 Windows x64](https://github.com/sievepub-2000/octocode/releases/download/v2.0.4/OctoCodeSetup.exe)
- [2.0.4 更新说明](release/v2.0.4.md)及[发布与校验说明](release/README.md)
- [免费编码模型实测](reports/openrouter-free-models-oct28.md)：大模型与放宽参数门槛后的轻量候选、实际速度、工具调用及筛选限制。

当前安装包约 742 MiB，包含桌面程序、核心扩展、Host、harness 和配套运行环境；首次使用仍需配置自己的模型服务及凭据。模型费用由所选服务决定。本版本仅提供 Windows x64 安装包。

## 主要功能

- **Windows 原生 IDE + Agent**：原生桌面编辑器、文件操作、PowerShell 终端、系统安装器及配套工具运行环境，代码编辑和 Agent 执行在同一工作台完成，无需先部署 Linux 容器。
- **开源、闭源与本地模型**：可接入应用列出的云端提供商、OpenRouter 聚合服务、OpenAI Compatible 网关及本地兼容推理 API；可配置开源权重与闭源商业模型。软件不直接加载任意权重，也不承诺兼容任意私有协议；工具调用、视觉、上下文和费用以实际模型及服务为准。
- **多配置管理**：分别保存提供商、服务地址、模型和凭据，新建配置不继承其他配置密钥。免费额度由上游决定，不保证持续免费或固定速度。
- **离线帮助与可验证更新**：作者信息、授权全文和手册随包分发；在线更新校验 Ed25519 签名、文件大小和 SHA-256，系统权限确认由 Windows 处理。

- **项目与对话管理**：新项目拥有自己的目录，新对话拥有独立执行目录。草稿、终端、附件和产物预览关联所属对话；运行时检查任务工作目录。
- **代码与任务执行**：原生 harness 负责代码检索、文件操作、命令及工具调用，支持会话检查点、上下文压缩和任务接续。
- **模型接入**：使用应用中的提供商配置或兼容网关接入模型；可通过 headless 接口让 GLM5.3 等模型运行工具并回测。
- **MCP 工具**：支持 MCP 配置与调用，发行环境包含代码审查等工具；部分可选工具需另外配置。
- **组件市场**：插件、Skills、MCP、运行环境共用市场入口和操作流程，每页最多 20 项，底部显示分页。Skills 接入 Agentic Awesome Skills 的 GitHub 目录，支持检索和按固定提交安装；慢网时明确显示随包快照来源。已安装组件优先，其他类别按来源热度排列。
- **项目代码索引**：在设置的“记忆和知识库”管理索引并搜索当前项目；原生索引提供离线符号和文本检索，也可配置嵌入服务使用语义检索。
- **界面与历史**：未设置时默认 Light，Light 使用白底，High Contrast Light 使用暖色浅底；Dark 使用黑底、炭灰与铜棕色强调。回答、思考和执行的居中时间标签精确到秒。
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

正式安装、用户数据、工作区、运行环境和安装验收均位于 `E:\Program Files\octocode`，三个数据目录使用真实目录，不再链接到 D 盘。D 盘仅用于源码与开发构建。升级通过新版安装器原位覆盖并保留用户状态；卸载保留非空用户数据目录。不要跟随旧版联接删除项目或凭据。已有用户可在程序内“检查更新”；私有仓库需要有效的 GitHub 读取授权，首次安装与独立恢复可从 Release 下载。

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

2.0.4 核心完整回归为 6,250 项通过、28 项条件跳过；新增“关于”和邮件链接回归 26 项通过，并完成真实浏览器离线展开文档检查。类型检查、lint、生产构建和安装包内容检查见 [2.0.4 报告](reports/v2.0.4-release.md)。本次只分发 Windows x64；组件浏览器测试不等于正式客户端安装验收，其他平台未执行的生命周期不计为通过。

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

2.0.4 将三处 `@hono/node-server` 锁定为 **2.1.3**，内置 Tornado 升级为 **6.6**，对应本轮六项新告警。真实漏洞复现、HTTP 回归、Python 运行环境、llm-wiki MCP 与完整核心测试等证据见 [2.0.4 报告](reports/v2.0.4-release.md)。本地审计不代替推送后的 GitHub 复扫；仓库状态见 [Dependabot](https://github.com/sievepub-2000/octocode/security/dependabot)。安全报告渠道见 [SECURITY.md](SECURITY.md)。

OctoCode 集成并改造多个开源组件，不宣称全部代码为原创。各组件保留其许可证和第三方版权说明；分发前请阅读 `desktop-shell/`、`octo-harness/`、`octocode-core/` 内的许可证及 notices。
