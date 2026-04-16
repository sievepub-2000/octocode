# Octocode 当前实现状态

## 已完成

### 仓库与规划

1. 本地复制 clawcode 源仓库
2. 创建 GitHub 私有仓库 `octocode`
3. 写入重构总方案文档
4. 写入 clawcode 到 octocode 模块迁移映射

### 工程骨架

1. Rust workspace 初始化
2. `octocode-core`
3. `octocode-api`
4. `octocode-commands`
5. `octocode-runtime`
6. `octocode-cli`

### 当前运行能力

1. provider registry
2. platform-aware doctor
3. file-backed session store
4. session add / list / export
5. workspace read-file / write-file
6. config init / config show
7. command registry
8. permissions surface
9. status surface
10. text + JSON CLI output

### 当前验证通过项

1. `cargo check --workspace`
2. `cargo test -p octocode-commands`
3. `status`
4. `doctor`
5. `providers`
6. `commands`
7. `session-add`
8. `session-export`
9. `tool read-file`
10. `tool write-file`

## 未完成

1. 真正的 provider client 实现
2. MCP lifecycle
3. plugin / skills / hooks
4. full slash-command parity
5. REPL
6. Canvas UI shell
7. VS Code / Cline / Cursor integration layer
8. 本地模型与闭源模型完整接入
9. release packaging
10. Windows/macOS 图形壳部署

## 当前里程碑定位

当前仓库已经从“规划阶段”进入“可编译、可运行、可测试、可推送的 runtime 内核起步阶段”。

## 下一阶段优先级

1. 真正的 provider abstraction 实现
2. runtime session / config / permissions 深化
3. command surface 扩充
4. REPL 与 conversation runtime
5. UI shell 引导层
