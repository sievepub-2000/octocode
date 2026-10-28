# GitHub Skills market replacement — 2026-10-28

This records the earlier 2.0.0 installation. Current 2.0.1 acceptance is tracked
in [v2.0.1-acceptance.md](v2.0.1-acceptance.md); its final UI lifecycle remains pending.

The user requested replacing the failing Skills discovery endpoint and approved
the proposed integration. The selected source is
[sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills),
using its documented stable v1 host discovery manifest. No upstream CLI, MCP
server or additional dependency is installed for discovery.

## Source and behavior

- Canonical commit: `b7f6ad814a903f912962ea3cccad8c02766f753b`.
- Original manifest Git blob: `0b2b21b1401d978d2e97c1590bfe791971cda9bf`;
  its exact downloaded bytes were verified against Git's blob hash.
- The original manifest has 2,872 rows. The snapshot retains 2,871 supported
  skill IDs, paths, names, descriptions and categories. One underscore-named
  entry does not satisfy the existing host name constraint and is excluded.
- Search and pagination use validated metadata, with 20 remote rows per page.
  Source order is preserved without inventing popularity measurements.
- A validated online request continues for at most 90 seconds; after 500 ms,
  slow-network users can browse the explicitly dated bundled snapshot. The
  online result is reused for later searches in the same extension host.
- Installations pin a Git commit and request only the selected skill's subtree.
  Existing path/link checks, file and byte limits, frontmatter validation and
  duplicate-install rejection remain enforced. Upstream licenses and source
  attribution accompany the extension and selected AAS skill.

Catalog metadata is discovery information, not an endorsement or a full review
of every upstream skill. Installed skills retain their individual licenses.

## Verified

- Initial discovery regression: 3 failed / 4 passed against the old provider.
- Added slow-network and subtree regression: 2 failed / 7 passed before fixes.
- Final focused community/registry suite: 23 passed; core types and lint passed.
- Final full core suite: 397 files passed, 7 files skipped; 6,245 tests passed
  and 28 conditionally skipped. The real network cases were run separately.
- Real GitHub online catalog, search and distinct-page test passed.
- Real selected skill installation (`pdf-conversion-router`), file/source
  readback, duplicate protection and removal test passed.
- The independent npm MCP test initially failed. A separate retry passed in
  181 seconds; its two unrelated GitHub tests were intentionally skipped in
  that retry. These are separate runs, not one aggregate all-green run.
- Full extension pipeline (types, lint, build, VSIX) passed. The three license
  and provenance files were verified inside the VSIX; compiled discovery uses
  the canonical GitHub source and contains no `skills.sh/api` reference.

## Artifact and current boundary

- Desktop product version: `2.0.0`; core extension: `0.1.13`.
- Installer: 777,616,805 bytes, SHA-256
  `b842cbcd6d48e9bfa97b1f5daa6f742a7d1b78c8fe3181dceebf80519552aafe`.
- VSIX: 85,903,964 bytes, SHA-256
  `55a5196ed28759644b88aa772104366219508f70226aec665c9e89e250d3f5b8`.
- Both artifacts are bound by the existing Ed25519 release identity, with a
  64-byte detached signature and the established pinned public fingerprint.

The new signed package was applied in place to `E:\Program Files\octocode`.
The native installer returned 0 at 2026-10-28 02:31:32 +08:00 and the current
user-state preservation comparison passed. Installed extension.js and all three
attribution files match the VSIX byte for byte; the installed VSIX hash matches
the signed manifest. Native ASAR verification passed for 45 unpacked files and
18 native modules. The complete installed self-test passed at 02:46:12 +08:00,
including code-review-graph (30 tools), llmwiki (14), Scrapling (4), and Windows
MCP (19). Optional toolchains not provisioned on this machine remain untested.

The user authorized resuming OctoCode UI acceptance, but Computer Use continued
to report the physical-Escape stop and refused window inspection. The running
desktop had been opened from Explorer without the software-test debugging port.
No final installed-market UI lifecycle is claimed. Latest startup logs also
record failed private GitHub update requests and an OpenRouter HTTP 403 provider
refusal; these remain unresolved, not dismissed as harmless warnings.

The release remains unpublished. Default-branch push, server-side advisory
re-scan, actual private-update acceptance and source cleanup remain gated by
final installed acceptance. Source/network tests and file identity do not
establish that the final installed UI has been retested.
