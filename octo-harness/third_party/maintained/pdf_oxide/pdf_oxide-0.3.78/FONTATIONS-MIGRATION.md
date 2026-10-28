# Maintained Fontations migration

Base: official `pdf_oxide 0.3.78` crate, archive SHA256
`95b1ecc1a60a314fbd1aea5fe8f700ec32af1efa70fef5c6879162444da3437d`.
Original upstream license and sources are retained.

The direct `ttf-parser 0.25` dependency is replaced with existing
`skrifa 0.44` and its `raw` re-export of `read-fonts 0.41`. Rendering remains enabled.
`fonts::font_face` shares validated SFNT/TTC parsing, unscaled metrics, original
Unicode-subtable priority, post/CFF glyph names, and TTF/CFF/CFF2 outlines between
font extraction, PDF embedding, and the text rasterizer. It does not synthesize
glyph names when the embedded font has none. Legacy format-2 cmap mapping is
retained because read-fonts exposes its records without a mapping implementation.
OS/2 USE_TYPO_METRICS remains conditional on OS/2 version >= 4.

Portable tests cover the shipped DejaVu font, missing/truncated data, format-2
mapping/deltas, and symbol/Unicode separation. Existing cmap/parser tests remain.
An isolated comparison probe additionally checks all glyph advances and names
against the previous parser for four shipped fonts and all Cambria TTC faces,
plus real CFF/CFF2 subsets from the official Fontations test data. Outline pixels
are compared through tiny-skia (no channel differences above one antialias level),
including every glyph in the CFF/CFF2 subsets. The old parser is only in that
external comparison probe, not this package's production dependencies.

External test-only subsets (not included in this distribution):

- `googlefonts/fontations/font-test-data/test_data/ttf/NotoSansJP-Regular.subset.otf`
  SHA256 `d3ca35b708367bfcbda288048fcd6483e609d618511a913ece34f4278e93a258`
- `googlefonts/fontations/font-test-data/test_data/ttf/NotoSansJP-VF.subset.otf`
  SHA256 `9a1d6c4e5ab1321fade0bde8905ee12ec7526c544223b55a0f20525cc3fa8eb5`
