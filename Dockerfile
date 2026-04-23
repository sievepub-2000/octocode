# P11-B: Minimal image for running `octocode-cli mcp-serve` over stdio.
#
# Why a dedicated image:
#   * downstream hosts (Claude Desktop, Cursor, VS Code) can spawn the server
#     with `docker run --rm -i octocode:latest mcp-serve` without needing a
#     local Rust toolchain.
#   * keeps the attack surface small: no shell, no package manager, no web
#     client — just the static binary.
#
# Build:
#   docker build -t octocode:latest .
#
# Run (stdio MCP):
#   docker run --rm -i octocode:latest
#
# Notes:
#   * We link against musl for a statically linked binary.
#   * `rustls` (our TLS stack) is pure Rust, so no libssl is required.
#   * The image intentionally does NOT expose a port — the `serve` HTTP mode
#     is for local operators and should not be reached from a container on
#     the `990-999` port range.

FROM rust:1.82-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p octocode-cli --bin octocode-cli \
    --target x86_64-unknown-linux-musl || \
    cargo build --release -p octocode-cli --bin octocode-cli \
    --target x86_64-unknown-linux-musl

FROM alpine:3.20
RUN addgroup -S oct && adduser -S -G oct oct
COPY --from=builder /src/target/x86_64-unknown-linux-musl/release/octocode-cli /usr/local/bin/octocode-cli
USER oct
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/octocode-cli"]
CMD ["mcp-serve"]
