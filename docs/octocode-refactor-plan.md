# Octocode 重构总方案

## 1. 目标边界

本项目的重构目标仅限于对 Claw Code / Claude Code 类能力进行重新分层、重新实现与工程化整合，不额外扩张到无关产品方向。

目标范围：

1. 保留并重构 agent CLI/runtime、session、tooling、permissions、memory、skills、plugins、MCP、provider routing、hooks、JSON output、doctor、resume 等核心能力。
2. 为 Windows、macOS 提供原生支持，包括系统路径、shell、工具执行、环境变量与配置目录差异处理。
3. 增加统一的 UI 壳层，采用 Web 技术显示，但渲染主界面采用 Canvas 而非 DOM 布局引擎，整体布局参考 VS Code：左侧导航，中部对话，右上工作区，右下终端区。
4. 接入本地模型与广泛的闭源在线模型，统一为 provider capability surface。
5. 兼容 VS Code 扩展、skills、MCPD 类能力，并吸收 VS Code、Cline、Cursor 的优点，但不扩大为新的通用 IDE 平台。

非目标：

1. 不在第一阶段重写一个完整浏览器内核。
2. 不在第一阶段重写完整 VS Code 扩展宿主。
3. 不追求一次性把全部交互表面做完，再反向补 runtime。

## 2. 对原项目的判断

Claw Code 当前的 Rust workspace 已经具备较完整的 CLI/runtime 主干，说明“功能缺失”不是最主要问题，“系统分层与可扩展边界不够稳定”才是主要问题。

原项目现状判断：

1. Rust 作为核心 runtime 语言是合理的，不建议再次整体替换语言。
2. 需要重构的是边界，而不是简单语法迁移。
3. 最应优先解耦的是 CLI、runtime、providers、tools、UI shell、integrations。
4. ACP/Zed、桌面 UI、多壳层接入应建立在稳定 runtime contract 之后。

## 3. 目标架构

建议采用分层 Rust monorepo：

1. `octocode-core`
   - 纯领域类型与 trait
   - session id、provider capability、tool contract、permission contract、workspace identity、artifact metadata
2. `octocode-api`
   - Anthropic
   - OpenAI compatible
   - xAI
   - DashScope
   - Ollama
   - llama.cpp / local gateway adapters
3. `octocode-runtime`
   - conversation engine
   - session store
   - permission engine
   - tool registry
   - workflow engine
   - MCP lifecycle
   - hooks / skills / plugin bridge
4. `octocode-cli`
   - REPL
   - one-shot prompt
   - slash command dispatch
   - doctor / status / export / resume
5. 未来扩展层
   - `octocode-ui-shell`
   - `octocode-vscode-host`
   - `octocode-integration-cline`
   - `octocode-integration-cursor`

## 4. 模块边界

### 4.1 Core

Core 只保留稳定协议，不依赖具体 provider、具体 UI、具体 shell。

必须进入 core 的内容：

1. `ModelProvider` trait
2. `SessionStore` trait
3. `ToolExecutor` trait
4. `PermissionPolicy` trait
5. `WorkspacePlatform` 枚举与平台能力描述
6. `UiShellSurface` 的抽象 capability 描述

### 4.2 API

API 只负责把统一模型请求转换为各 provider 的 wire payload，不负责 CLI 交互和 session 生命周期。

### 4.3 Runtime

Runtime 负责：

1. 会话状态
2. prompt assembly
3. tool call 调度
4. permissions
5. session persistence
6. workflow state
7. MCP/service/plugin 运行生命周期

Runtime 不直接依赖具体 UI 壳层。

### 4.4 UI Shell

UI Shell 必须是运行时之上的消费者，而不是反向把 runtime 嵌在 UI 逻辑里。

Canvas UI 约束：

1. WebView / embedded browser 只作为承载容器
2. 核心布局、文本层、光标、分栏、滚动逻辑走 Canvas 渲染
3. DOM 仅用于宿主、无障碍桥接、输入法桥接、文件拖放等必要能力

## 5. 平台策略

### 5.1 Windows

1. 默认 shell 先支持 PowerShell 5.1 与 PowerShell 7。
2. 配置目录优先读取 `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`。
3. Tool 执行要区分 cmd、powershell、wsl、git-bash。
4. 路径、换行、权限、进程树回收做显式适配。

### 5.2 macOS

1. 默认 shell 支持 zsh。
2. 配置目录兼容 `~/Library/Application Support` 与 XDG 风格路径。
3. 后续 UI 壳层对接 `.app` 包装与 LaunchServices。
4. 注意 TCC、签名、沙箱外部调用的限制。

## 6. Provider 策略

统一抽象为：

1. chat completion / messages
2. streaming
3. tool calling
4. structured output
5. reasoning control
6. auth modes
7. endpoint capabilities

这样可以同时覆盖：

1. Anthropic
2. OpenAI / OpenRouter / local OpenAI-compatible
3. xAI
4. DashScope
5. Ollama
6. llama.cpp 及本地代理层

## 7. 吸收 VS Code / Cline / Cursor 的点

### 从 VS Code 吸收

1. 清晰的工作区概念
2. 扩展宿主边界
3. 任务、终端、问题面板、文件树协作方式

### 从 Cline 吸收

1. 面向代理的任务流
2. 本地文件修改与 shell 协作流程
3. 明确的用户确认点

### 从 Cursor 吸收

1. 编辑器内联工作区体验
2. 对代码上下文的快速定位与应用动作
3. 聊天区与工作区协同

## 8. 重构原则

1. 以重构为主，新开发为辅。
2. 先建立统一 contract，再做功能搬迁。
3. 每个模块都要可单独测试。
4. 每个壳层都只能依赖 runtime capability，不直接操作底层状态文件。
5. 先 CLI parity，再 UI parity。

## 9. 实施阶段

### 阶段 A：底座

1. 建立 workspace
2. 定义 core traits
3. 建立 provider/runtime/cli 三层

### 阶段 B：功能迁移

1. 迁移 provider routing
2. 迁移 session store
3. 迁移 permissions
4. 迁移 tools
5. 迁移 slash commands
6. 迁移 skills/plugins/MCP

### 阶段 C：跨平台加固

1. Windows shell/tool 适配
2. macOS shell/tool 适配
3. config dir 与 credential store 适配

### 阶段 D：UI 壳层

1. 建立嵌入式 Web UI shell
2. 以 Canvas 为主实现 IDE 风格界面
3. 对接 runtime event bus

### 阶段 E：集成层

1. VS Code integration
2. Cline-compatible workflow bridge
3. Cursor-like workspace affordance

## 10. 当前执行策略

当前轮次优先完成：

1. 建立 octocode Rust workspace
2. 建立核心 crate 骨架
3. 明确 trait 与边界
4. 为后续从 clawcode 迁移代码做准备

本轮不声称已经完整实现 clawcode 与 claudecode 的全部功能，也不声称已经完成 UI 与全部在线模型接入。后续工作必须基于可验证的分阶段交付推进。

## 11. 2026-04-17 参考仓库增量结论

本轮额外综合了以下四个参考仓库：

1. `github/claude-code-1`：官方公开仓库，重点价值在插件组织方式与公开产品面说明。
2. `github/claude-code-2`：基于 `@anthropic-ai/claude-code@2.1.88` source map 还原的完整源码研究仓库，重点价值在工具、命令、MCP、多 agent 协调与权限分层。
3. `github/claude-code-3`：另一份 2.1.88 级别源码恢复仓库，重点价值在 `src/` 与 `vendor/` 的更直接项目组织方式。
4. `github/claude-code-learn`：基于公开资料的架构研究文档仓库，重点价值在对 MCP、遥测、远程控制、多 agent harness 的系统化总结。

基于这四个仓库，本项目继续坚持以下策略：

1. 主体语言仍选 Rust，而不是整体切换到 Go 或 Zig。
2. UI / SDK / 扩展宿主可以保留 TypeScript 层，但 runtime、permissions、tools、MCP、provider router 继续收口到 Rust。
3. 第一优先级不再是继续堆前端壳层，而是补齐 `MCP -> 多 agent -> 工具系统 -> 权限系统` 的 runtime 深水区。
4. 迁移原则是提炼模块边界与行为模式，不直接复制第三方源码。

