# OctoCode — 下一步工作计划

> 基于项目分析评估报告, 按优先级排列

---

## Sprint 1: 安全加固 + 代码卫生 (1-2 天)

### S1.1 路径安全白名单 🔴 高优先级
- 在 `WorkspaceToolExecutor` 中添加路径规范化检查
- 所有文件操作工具(read-file, write-file, delete-file, move-file, create-file, append-file)验证路径不逃逸 workspace 根目录
- 使用 `std::fs::canonicalize` + `starts_with(workspace_root)` 验证
- 添加 5+ 个路径穿越攻击测试用例

### S1.2 Clippy 清零 🟡 中优先级
- 修复 11 个 clippy warnings:
  - `new_without_default`: ProviderRegistry, McpRegistry 添加 `Default` impl
  - `items_after_test_module`: 移动函数到 test 模块之前
  - `manual_clamp` / `manual_div_ceil`: 使用标准库方法
  - `large_enum_variant`: Box 包装大变体
  - `too_many_arguments`: 提取参数结构体
- CI 中启用 `RUSTFLAGS: -D warnings` (已有, 确保 clippy 也 -D)

---

## Sprint 2: 文档 + 用户体验 (2-3 天)

### S2.1 README.md 🔴 高优先级
- 快速开始指南 (安装、配置、首次运行)
- Provider 配置示例 (local-openai, ollama, linkmind)
- 环境变量参考表
- 架构图 (ASCII)

### S2.2 配置文件迁移
- INI → TOML 格式 (使用 `toml` crate, 仅 ~50KB)
- 保持向后兼容: 自动检测旧格式并提示迁移
- 支持注释和多行值

### S2.3 LinkMind 集成文档
- LinkMind Agent Mate 模式配置指南
- lagi.yml 配置示例
- 多模型路由 (`best(...)` / `pass(...)`) 使用方法

---

## Sprint 3: 可靠性增强 (2-3 天)

### S3.1 优雅关闭
- SIGINT/SIGTERM 信号处理 (Ctrl+C 优雅退出)
- 使用 `ctrlc` crate 或 raw signal handler
- ThreadPool drain + connection 等待

### S3.2 E2E 测试自动化
- 将 E2E 测试从 `#[ignore]` 改为条件编译 (`cfg(feature = "e2e")`)
- CI 中添加 E2E 测试 job (先 build, 再运行 e2e)
- 添加 WebSocket E2E 测试

### S3.3 连接复用
- ureq Agent 缓存 (per-provider)
- 保持 HTTP/1.1 Keep-Alive 连接

---

## Sprint 4: LinkMind 深度集成 (3-5 天)

### S4.1 Agent 端点
- 接入 LinkMind `/chat/go` (Agent 执行)
- 映射 tool_calls 到 LinkMind function calling

### S4.2 RAG 工具
- 新增 `vector-search` 工具 → LinkMind `/v1/vector/search`
- 新增 `vector-upsert` 工具 → LinkMind `/v1/vector/upsert`

### S4.3 多模态工具
- `image-generate` → LinkMind 图像生成
- `speech-to-text` → LinkMind ASR/TTS
- `ocr` → LinkMind OCR 端点

---

## Sprint 5: 性能与扩展 (长期)

### S5.1 异步运行时评估
- 评估 tokio mini-runtime (仅 HTTP client async)
- 保持 CLI 同步, 仅 server 模式启用 async

### S5.2 Plugin SDK
- 稳定插件 trait 接口
- 发布 plugin 开发模板
- WASM 插件支持评估

### S5.3 UI 增强
- WebUI 深色主题
- 流式打字机效果改进
- 工具执行可视化面板

---

## 度量目标

| 指标 | 当前 | Sprint 1 后 | Sprint 3 后 |
|------|------|-------------|-------------|
| 测试数 | 75 | 85+ | 100+ |
| Clippy warnings | 11 | 0 | 0 |
| 安全漏洞 | 1 (路径穿越) | 0 | 0 |
| Provider 类型 | 8 | 8 | 8 |
| 文档页数 | 0 | 3+ | 5+ |
