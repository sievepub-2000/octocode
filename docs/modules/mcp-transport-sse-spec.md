# Iteration E: MCP Transport + SSE Streaming

## 目标

1. 实现 MCP stdio transport：可发现→生成子进程→通过 stdin/stdout JSON-RPC 通信
2. 实现 SSE 流式响应：`GET /api/stream?session=...` 端点，Provider 逐 token 推送
3. 为 OpenAI-compatible Provider 添加 `stream=true` 支持

## 约束

- 不引入额外运行时依赖（tokio 已在 workspace 中）
- 保持现有 99/99 回归不退化
- SSE 端点与现有 request-response 端点共存（非替换）
- MCP 进程生命周期由 runtime 管理，server 退出时清理

## 验收条件

1. `cargo test --workspace` 通过（原 29 + 新增）
2. MCP: 可在 mcp/ 目录放置 manifest → `mcp list` 显示 Running 状态
3. SSE: `GET /api/stream?session=demo&text=hello` 返回 `text/event-stream` 分块
4. 回归脚本新增 Section 22（MCP spawn）+ Section 23（SSE stream）
5. Provider streaming: POST body 包含 `"stream":true`，逐行读取 `data:` 前缀

## 实现切片

### E.1 MCP stdio transport
- `octocode-mcp/src/lib.rs`: 添加 `McpTransport` struct，spawn + stdin/stdout 管理
- `octocode-mcp/Cargo.toml`: 无新依赖（std::process 足够）
- `octocode-runtime/src/lib.rs`: 启动时对 trusted MCP 执行 spawn

### E.2 SSE streaming endpoint
- `octocode-cli/src/server.rs`: 新增 `GET /api/stream` 路由
  - 检测 Accept: text/event-stream
  - 写入 chunked response headers
  - 逐 token 写入 `data: {...}\n\n`
  - 结束时写入 `data: [DONE]\n\n`

### E.3 Provider streaming
- `octocode-core/src/lib.rs`: 添加 `StreamCallback` type alias
- `octocode-api/src/lib.rs`: OpenAiCompatibleProvider::prompt_stream()
  - POST body 加 `"stream":true`
  - 逐行解析 `data: {json}` 提取 delta.content
  - 每个 delta 调用 callback

### E.4 回归测试
- Section 22: MCP manifest → spawn → list shows Running
- Section 23: SSE endpoint → chunked response → contains event data
