# GitHub Skills market

The user requested a working open-source Skills market and approved proceeding
with the proposed integration. Preserve the existing desktop, installed skills,
20-item UI pagination and guarded GitHub installation pipeline.

## Approaches

- skills.sh: existing discovery endpoint repeatedly failed in the installed app.
- VoltAgent/awesome-agent-skills: broad MIT collection, but discovery is a README
  rather than a structured API. Parsing editorial Markdown adds avoidable risk.
- numman-ali/n-skills: structured, Apache-2.0, but currently only five plugins.
- sickn33/agentic-awesome-skills: selected. Its documented stable v1 JSON manifest
  contains skill IDs, relative paths, names, descriptions, categories and source
  metadata. Consume the canonical repository directly; do not install its CLI.

## Behavior and limits

Replace skills.sh discovery with the AAS GitHub manifest. Search metadata locally
and page through the source's order; do not invent popularity counts. Keep a
dated, commit-bound catalog snapshot so a failed network request does not erase
the entire market. Label snapshot results clearly. Cache one validated catalog
per extension-host process so pagination does not redownload the whole index.

Only catalog metadata ships with OctoCode. Download a selected skill's actual
files on demand. Retain revision pinning, directory ownership, file type and
path checks, file and byte limits, frontmatter validation, and refusal to
overwrite existing skills. Preserve source attribution and applicable licenses.
No additional dependency or service is needed.

Verify live catalog access, search, distinct pages, fallback provenance, unsafe
metadata rejection, actual installation, readback, duplicate-install protection
and uninstall. Rebuild the extension and installer, perform an in-place E-drive
upgrade, and verify the installed result before resuming the 2.0 release gates.
