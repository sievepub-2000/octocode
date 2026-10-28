# OctoCode maintained PDF dependency

Base: official `pdf_oxide 0.3.78`, archive SHA256
`95b1ecc1a60a314fbd1aea5fe8f700ec32af1efa70fef5c6879162444da3437d`.
The upstream version and licenses are retained. This is a modified dependency
inside OctoCode, not a separately published upstream release.

See `FONTATIONS-MIGRATION.md` for the font parser replacement and comparisons.

Soft-mask transfer functions now share a 256-node parsing budget and a maximum
depth of 32. This bounds indirect reference cycles and repeatedly shared trees
before allocating their child vectors. Type 3 domains and partition bounds must
be finite and ordered; encoding endpoints must be finite. Invalid functions use
the existing Identity fallback. Valid descending encoding endpoints still work.
Evaluation also checks the domain before calling `clamp`.

Verification: `cargo test -p xai-grok-tools --test pdf_transfer_regressions`
runs seven real PDF rendering regressions covering malformed references,
resource limits, invalid domains and normal output. The font migration has
separate parser and rendering comparisons described in its maintenance note.
