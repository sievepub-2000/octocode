# OctoCode 1.132.1（Windows x64）

本次发布把桌面程序升级至 **1.132.1**、OctoCode 扩展升级至 **0.1.7**，并从 3 号机当前的根仓库、桌面、Rust harness 和核心组件源码重新构建安装包。3 号机的标准安装路径为 `D:\Program Files\OctoCode`。安装初始化在新扩展注册成功后会校验并清理旧版本 OctoCode 扩展目录，避免升级后同一运行目录保留两份版本包。

本版修复任务批准的时效、一次性使用及任务身份校验；任务取消和切换时会清理待决批准，Workbench MCP 在执行前复查权限，并拒绝可能绕开单次批准的批量请求。文件展示要求活动任务身份，相对路径使用任务工作目录；无 payload 查询、服务关闭后的失效端点和错误归因也已修复。DeepSeek provider 现在拒绝空白密钥，向 SDK 传递取消信号，保留显式关闭 max tokens 的设置，并修正请求分支与类型。还修复了 Swift tree-sitter 查询、桌面协议和构建配置、Node 测试版本回退、Windows Rust 路径与测试兼容问题。

Windows 构建验证包括核心测试、lint、类型检查、扩展打包、桌面编译与相关测试，以及 Rust 格式检查。具体通过数量、安装后的实测结果、SHA-256 和未覆盖项目见仓库 `reports/full-audit-and-github-refresh-20260930.md` 及本版本附带的 `release-manifest.json`。Open Code Review 的大规模 LLM 审查尚未完成；报告按真实完成文件数给出覆盖率。

本安装包采用离线覆盖安装。3 号机的维护脚本先备份并核对当前用户数据，再卸载旧版、创建指向项目运行目录的原生 junction、运行新安装包，并做读回检查。在线更新 URL 仍为占位值，本次不宣称已经部署在线更新服务。
