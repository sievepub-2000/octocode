# OctoCode maintained syntect dependency

Based on the unmodified published syntect 5.3.0 crate recorded in UPSTREAM.json.
Original version, copyright notices, licenses, bundled syntax/theme dumps and
source remain available. The parent harness Cargo.lock governs resolution.

Changes:

- Replace the unmaintained yaml-rust parser with maintained yaml-rust2 0.13.
- Replace unmaintained bincode 1 with maintained bincode-next 3.1.1 serde APIs.
  Dependency aliases retain the existing import names; Cargo.lock records the
  actual maintained package identities.
- Explicit legacy fixed-width, little-endian encoding preserves the binary
  representation used by upstream syntect and two-face syntax/theme assets.
- Dump I/O functions use std::io::Result, preserving underlying I/O error kinds;
  malformed serialization data returns InvalidData. Harness callers do not bind
  to the replaced dependency's concrete error type.
- Finish compressed streams and flush writers explicitly so save failures are
  returned to callers instead of being discarded by buffer/encoder Drop.
- Keep truncated sequence reads as I/O errors, because bincode-next's serde
  decoder otherwise treats UnexpectedEnd as a successful short sequence.
- Make an existing YAML parser lifetime explicit for current Rust compilers.

Compatibility validation must include existing embedded syntax and theme dumps,
YAML syntax parsing, compressed/uncompressed round trips, legacy encoded bytes,
and corrupted/missing-file failures. No warning or advisory is suppressed.
