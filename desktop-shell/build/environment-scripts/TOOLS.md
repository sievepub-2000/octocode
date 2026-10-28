# OctoCode 系统工具目录

更新时间：2026-10-25（Asia/Shanghai）

本文件位于安装目录的 `environments/TOOLS.md`，统一说明 `tools` 下的系统工具。
默认安装位置为 `E:\Program Files\octocode`；自定义安装位置时所有路径跟随安装目录。

| 类型 | 相对 environments 的目录 | Agent 使用方式 |
| --- | --- | --- |
| Skills | `tools/skills/<名称>/SKILL.md` | 自动发现技能说明，按任务需要读取 SKILL.md 后使用 |
| MCP | `tools/mcp` | `mcp_settings.json` 为唯一服务配置；通过已连接 MCP 的工具列表调用 |
| Hooks | `tools/hooks` | 加载目录中的 Hooks JSON，由 Agent 生命周期事件触发 |

OctoCode 安装的 Skills、MCP、Hooks 和插件均为系统级工具，供所有工作区共享。项目调用工具时在 `.octocode/tool-copies` 下建立会话隔离的配置、引用和数据目录；副本不含工具程序或依赖包，也不构成独立安装。关闭项目会话时清理该会话目录，删除项目时随工作区清理，不影响全局工具。升级和迁移不得把来源不明的旧项目文件擅自提升为全局工具或删除。
模式专用技能位于 `tools/skills/.modes/<模式>/<名称>/SKILL.md`。
Node、Python 等基础解释器仍由 environments 中的公共运行环境提供。
VS Code 编辑器插件使用产品级 `data/extensions`，其工作区状态使用独立的项目数据，不与 Agent Hooks 混用。

Google Harness² 通过 `bin/octocode-harness2.cmd` 或
`environments/scripts/octocode_harness2.py` 调用现有本地任务 API，使用当前选择的模型。
它提供任务级提案、验证与组合，采用只读工具；不会替换 Rust 执行引擎或开启写入权限。
运行证据与显式采纳的提示保存在各项目 `.octocode/harness2`，不跨项目共享。
详细用法及 Windows 接入范围见仓库 `docs/HARNESS2.md`。

安装、启用、禁用、卸载通过 OctoCode 组件市场完成；卸载 MCP 先停止连接再移除注册和其专有文件，不删除公共解释器。
升级保留已安装的用户工具及配置。系统卸载解除安装目录链接；项目 runtime 中保留的数据需按明确的清理选项另行删除。
预置 MCP 的程序和依赖包通过版本、身份和文件校验后暂存替换；失败时回滚程序。MCP 配置、用户 Skills、Hooks 和知识数据继续保留。未知文件或改动过的受管理程序发生冲突时，升级会保留原文件并报错。
不要向本说明文件写入密钥。需要认证的 MCP 应使用产品的凭据管理。
