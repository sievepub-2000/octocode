# OctoCode maintenance patch

Upstream: tikv-jemalloc-ctl 0.6.1,
https://static.crates.io/crates/tikv-jemalloc-ctl/tikv-jemalloc-ctl-0.6.1.crate
SHA-256: 661f1f6a57b3a36dc9174a2c10f19513b4866816e13425d3e418b11cc37bc24c

Replace discontinued paste with its maintained pastey continuation under the
existing dependency alias. Retain the generated allocator control API.
The historical crate version and upstream licenses are retained.

Jemalloc is Unix-only in OctoCode; Windows checks cannot validate its runtime.
Validate the crate and allocator control tests on Linux before distribution.
The dependency uses the root Cargo.lock; the upstream development lock is not
an alternative OctoCode dependency source.
