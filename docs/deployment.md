# Octocode 本地部署说明

## 当前可部署形态

当前仓库已经具备“本地开发部署”能力，目标是让开发机可以快速获得一个可运行的 octocode CLI 基线。

当前部署范围：

1. Rust workspace 构建
2. 本地 CLI 启动
3. 配置文件初始化
4. 基础状态诊断
5. 本地 session 持久化
6. 会话 transcript 持久化
7. 最小工作区文件工具
8. 权限分级工具执行
9. UI snapshot 导出
10. 最小静态 WebUI 壳

当前不包含：

1. 桌面 Canvas UI 壳层
2. VS Code / Cline / Cursor 集成壳层
3. 全量 provider 接入
4. 完整 MCP / plugin / skills / hooks parity

## 依赖

1. Rust toolchain
2. Cargo
3. Windows: PowerShell 5.1 或 PowerShell 7
4. macOS / Linux: bash 或 zsh

## Windows 启动

```powershell
Set-Location C:\Users\周浩\vscode-workspace\octocode
cargo run -p octocode-cli -- doctor
```

便捷启动脚本：

```powershell
./scripts/start-local.ps1 doctor
./scripts/start-local.ps1 status
./scripts/start-local.ps1 --json commands
```

Windows WebUI 启动：

```powershell
./scripts/start-webui.ps1 -Port 4173
```

## macOS / Linux 启动

```bash
cd /path/to/octocode
cargo run -p octocode-cli -- doctor
```

便捷启动脚本：

```bash
./scripts/start-local.sh doctor
./scripts/start-local.sh status
./scripts/start-local.sh --json commands
```

macOS / Linux WebUI 启动：

```bash
./scripts/start-webui.sh 4173
```

## 初次初始化建议

```bash
cargo run -p octocode-cli -- config-init
cargo run -p octocode-cli -- doctor
cargo run -p octocode-cli -- providers
cargo run -p octocode-cli -- chat demo "hello octocode"
cargo run -p octocode-cli -- ui-export ui-shell/data/app-state.json demo
```

完成以上步骤后，通过浏览器打开：

```text
http://127.0.0.1:4173/ui-shell/
```

## 当前验证基线

本地验证命令：

1. `cargo check --workspace`
2. `cargo test -p octocode-commands`
3. `cargo run -p octocode-cli -- status`
4. `cargo run -p octocode-cli -- --json status`
5. `cargo run -p octocode-cli -- chat demo "hello octocode"`
6. `cargo run -p octocode-cli -- tools`
7. `cargo run -p octocode-cli -- tool shell-command "Get-Location"`
8. `cargo run -p octocode-cli -- ui-export ui-shell/data/app-state.json demo`
9. `http://127.0.0.1:4173/ui-shell/` WebUI 真实打开验证

## 下一阶段部署目标

1. 产出 release 构建脚本
2. 产出 Windows/macOS 打包脚本
3. 增加运行时环境检查
4. 增加真正的本地和在线 provider client
5. 将静态 UI shell 升级为交互式桌面壳
