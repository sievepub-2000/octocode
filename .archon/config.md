# OctoCode – Archon Integration

## Project Type
Rust workspace with 9 crates, custom HTTP server with WebUI.

## Build Commands
```bash
# Must set these env vars first:
export CARGO_HOME=c:\Users\周浩\vscode-workspace\.cargo
export RUSTUP_HOME=c:\Users\周浩\vscode-workspace\.rustup

# Lint
cargo clippy --workspace --all-targets -- -D warnings

# Test
cargo test --workspace

# Build release
cargo build --release --bin octocode-cli

# Run server
./target/release/octocode-cli serve 10029
```

## Crate Dependency Graph
```
octocode-core (domain types, traits)
├── octocode-api (provider registry, HTTP, streaming)
├── octocode-mcp (MCP discovery)
├── octocode-skills (skill framework)
├── octocode-plugins (plugin trait/host)
├── octocode-mock-provider (test stub)
└── octocode-runtime (session, tools, coordinator)
    └── octocode-commands (CLI command parsing)
        └── octocode-cli (server, desktop, main)
```

## Key Files
- `crates/octocode-cli/src/server.rs` — HTTP server (1330+ lines)
- `crates/octocode-runtime/src/lib.rs` — Runtime, tools, sessions
- `crates/octocode-api/src/lib.rs` — Provider registry, circuit breaker
- `crates/octocode-core/src/lib.rs` — Domain types
- `ui-shell/` — Static WebUI (HTML/JS/CSS)

## Quality Gates
- 0 clippy warnings (enforced with `-D warnings`)
- All workspace tests pass
- WebUI serves on configured port
