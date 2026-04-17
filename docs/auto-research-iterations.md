# Octocode Auto-Research Iterations

## Iteration 2026-04-17-A

- Hypothesis:
  把 Ollama 提升为一等 provider、把 CLAUDE.md / AGENTS.md 提升为 runtime bootstrap、并为 Hook 生命周期先起一个可审计骨架，可以同时提升功能完整性和后续迭代速度；如果新增逻辑采用缓存和最小可观测面，非 provider 本地路径不会退化。
- Correctness change:
  - 新增 `ollama` provider descriptor 与 fallback 链路。
  - 新 session 自动注入 `CLAUDE.md` / `AGENTS.md` 项目上下文。
  - 新增 `octocode-plugins` crate，并接入 `session-start` / `before-prompt` / `after-prompt` / `before-tool` / `after-tool` 生命周期。
  - 回归脚本新增 `ollama` provider 暴露检查与 plugin audit 可见性检查。
- Performance change:
  - 为 workspace bootstrap context 增加进程内缓存，避免每个新 session 重复读取上下文文件。
  - 保持 plugin 骨架为审计型 host，不引入动态加载和额外 I/O。
- Validation:
  - `cargo test -p octocode-api -p octocode-runtime --lib`
  - `cargo test -p octocode-plugins -p octocode-runtime --lib`
  - `cargo build -p octocode-cli --release`
  - `powershell -ExecutionPolicy Bypass -File scripts/test-regression.ps1 -Port 10021 -Session demo`
  - 真实 WebUI 已打开：`http://127.0.0.1:10021/ui-shell/?session=demo`
- Result:
  - 单测通过。
  - release 构建通过。
  - WebUI/API 回归通过 `80/80`。
  - 仍存在一条 `get_errors` 对 `scripts/test-regression.ps1` 的疑似误报，但不影响脚本执行与结果。
- Keep / Discard:
  - Keep：Ollama 一等接入、context bootstrap、plugin 审计骨架、context cache。
  - Discard：无。
- Next bottleneck:
  - plugin host 还只是进程内审计，没有插件发现、启停、配置和持久化。
  - session fork / branch 还未开始。
  - provider token/cost 追踪仍是粗估，需要更准确模型。
