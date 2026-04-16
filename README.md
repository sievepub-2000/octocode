# Octocode

Octocode is a ground-up refactor target inspired by the current Claw Code runtime shape.

This repository is being structured around four principles:

1. Keep feature parity work explicit and testable.
2. Separate stable runtime contracts from UI shells and integrations.
3. Treat Windows and macOS as first-class platforms.
4. Prefer mature implementations and constrained refactoring over speculative rewrites.

The initial workspace layout is intentionally small:

- `crates/octocode-core` - shared contracts and domain types
- `crates/octocode-api` - provider-facing model integration layer
- `crates/octocode-runtime` - session, tools, permissions, workflows
- `crates/octocode-cli` - the local CLI shell over the runtime

Detailed planning lives under `docs/`.
