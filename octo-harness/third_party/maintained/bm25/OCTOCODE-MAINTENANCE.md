# OctoCode maintenance patch

Upstream: bm25 2.3.2, https://static.crates.io/crates/bm25/bm25-2.3.2.crate
SHA-256: 1cbd8ffdfb7b4c2ff038726178a780a94f90525ed0ad264c0afaa75dd8c18a64

Replace discontinued fxhash with std::hash::DefaultHasher. Token identifiers
remain consistent within the running index. OctoCode rebuilds this in-memory
index on each search and never persists its hashed token identifiers.
Preserve the embedding, tokenization, ranking and public TokenEmbedder API.
The historical crate version and upstream licenses are retained.

Validate with the embedding tests and xai-grok-shell tool_index_tests.
The dependency uses the root Cargo.lock; the upstream development lock is not
an alternative OctoCode dependency source.
