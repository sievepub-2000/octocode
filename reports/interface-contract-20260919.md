# OctoCode 统一接口规范（2026-09-19）

本规范约定：扩展 agent 的四类组件（MCP 服务、技能、Agent 模式、运行环境）各自在哪里安装、在哪里配置、如何被调用。原则是"复用现有管理器、只加一层契约"：本轮没有新增任何平行的管理逻辑。

## 1. 统一契约

`packages/types/src/extensions.ts` 定义了以下类型：

- `ExtensionKind`：`mcp | skill | mode | environment`。
- `ExtensionEntry`：统一条目结构。主要字段：
  - `id` / `name` / `scope`：作用域取 `global`、`project` 或 `system`。
  - `installed` / `enabled` / `builtIn`：安装状态、启用状态、是否随产品内置。
  - `actions`：当前可执行的操作，界面只渲染这里列出的按钮。
- `ExtensionRequest`：`list | install | uninstall | enable | disable`，参数为 `kind`、`id` 和可选的 `scope`。
- `ExtensionResult`：`{ entries, error? }`。操作被拒时返回 `error`，不抛异常，同时一并返回最新列表。

## 2. 分层与入口

| 层 | 入口 | 实现 |
|---|---|---|
| 安装 / 卸载 / 启停 | 组件市场（Marketplace 视图）：扩展、技能、MCP 服务、Agent 模式、**运行环境（新增）** | webview `extensionRequest` → `ExtensionRegistry.handle` → 各管理器 |
| 配置 | 设置页分区（MCP、技能、模式、终端/执行路由），即侧边栏横线以上的配置入口 | McpView / SkillsSettings / ModesView / `octocode.*` 设置 |
| Agent 调用 | 工作台 MCP 的 `tools` 工具（search / status / invoke） | `ToolHub`：`mcp`、`skill`、`mode`、`vscode`，以及**新增的 `environment`**（invoke 即安装，需要完整权限） |
| 系统调用 | host JSON-RPC（`capabilities.list` 是完整的方法注册表） | `octocode-host` |
| 外部接入 | 守护进程 HTTP：`/v1/runs`、`/v1/goals`、`/v1/routines`、**`/v1/extensions`（只读，结构同上）** | `environments/scripts/octocode_api.py` |

`ExtensionRegistry`（`src/services/extensions/ExtensionRegistry.ts`）本身不持有状态，所有操作都委托给已有的管理器：

| 类型 | 列出 | 安装 | 卸载 | 启用 / 停用 |
|---|---|---|---|---|
| mcp | McpHub（已装）+ 市场目录（未装） | MarketplaceManager | McpHub.deleteServer | McpHub.toggleServerDisabled |
| skill | SkillsManager（已装）+ 内置目录（缺失项） | SkillsManager.installBundledSkills | SkillsManager.deleteSkill | — |
| mode | CustomModesManager + 市场目录 | MarketplaceManager | CustomModesManager.deleteCustomMode | — |
| environment | manifest + EnvironmentProvisioner.isInstalled | Provisioner.ensure（按需下载） | Provisioner.remove（**新增**；核心环境拒绝卸载；WSL 执行 unregister） | — |

## 3. 本轮一并消除的重复与分叉

- **默认技能单一来源**：以安装器预置的 `.build/workspace/.agents/skills` 为唯一来源。
  - 扩展的 `assets/default-skills` 在构建时由 `octocode-build.ps1` 镜像同步，其中保留 SUPERPOWERS-LICENSE。
  - 扩展启动时不再往全局目录复制默认技能。原先同一批技能在全局和项目作用域各出现一份，共 15 份重复，现已移到备份目录。
  - "恢复默认技能"只补齐在任何作用域都不存在的技能，写入产品工作区。
- **浏览器类工具**：只保留工作台浏览器（可见、可交互）和 Scrapling（搜索、抓取、渲染）。obscura 已下线。
- **记忆**：只保留 harness 记忆一套，context-mode 已下线。
- **死路径**：
  - workbench 中从未注册的 `search_web` / `fetch_url`；
  - host 的 Curator 角色；
  - 扩展侧手动 handoff（按钮、消息处理和 `prepareHandoff`），以及只为它服务的 `transferringSessions` 状态。
  - host 的 `harness.handoff` RPC 保留为能力，目前没有前端调用方。

## 4. 约束（不变量）

1. 新增扩展类型时，必须同时实现 `ExtensionRegistry.listKind/apply` 两个分支，并在 `ToolHub` 中说明它是否可被 agent 调用。
2. 界面只渲染 `entry.actions` 中列出的按钮，不在前端另写可用性判断。
3. 核心环境（`tier: "core"`）永远不出现 uninstall 操作；provisioner 在后端再校验一次。
4. 守护进程只读列出，安装和卸载只在应用内进行，保持唯一的安装入口。
