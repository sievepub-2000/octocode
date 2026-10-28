# OctoCode maintenance patch

Upstream: rhai 1.25.1, https://static.crates.io/crates/rhai/rhai-1.25.1.crate
SHA-256: dd4dd0f8c36625202a4ba553c416c19b719947cd2a31d1bda06126e4a5727daf

Replace discontinued smartstring storage with alloc::string::String and its
const new() constructor. Retain parser, evaluator, serde and public scripting
behavior. Small strings may allocate more often. No scripts or features are
removed. The historical crate version and upstream licenses are retained.

Validate Rhai's existing string/parser tests and OctoCode Mermaid rendering.
StepRange compares increment function addresses explicitly with fn_addr_eq;
the maintenance patch therefore declares Rust 1.85 as its minimum version.
The dependency uses the root Cargo.lock; the upstream development lock is not
an alternative OctoCode dependency source.
