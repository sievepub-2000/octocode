# GitHub Skills Market Implementation Plan

> Execute inline using superpowers:executing-plans; the user requested that the
> primary agent complete this work without subagents.

**Goal:** Replace the failing Skills market discovery source with the canonical
AAS GitHub catalog while preserving safe installation and existing user data.

**Architecture:** Adapt the stable v1 manifest in the existing community service.
Ship a verified metadata snapshot, label its provenance, and reuse the current
registry, pagination and installer. Cache the validated online result per host.

**Tech Stack:** Existing TypeScript, Zod, Vitest and bundled Node/Python.

**Spec:** ../specs/2026-10-28-github-skills-market-design.md

## Constraints and review focus

- Do not add dependencies or execute downloaded catalog instructions.
- Preserve existing skill IDs and protect installed directories from overwrite.
- Validate GitHub IDs, paths, links, byte limits and YAML metadata at boundaries.
- Distinguish a live catalog from the dated bundled snapshot.
- Do not treat source/network tests as installed UI or release acceptance.

## Steps

- [x] Download and verify the canonical manifest, schema, licenses and commit;
      generate only the required metadata and record provenance.
- [x] Add failing discovery tests for GitHub identity, search, pagination,
      invalid metadata and labeled offline fallback.
- [x] Implement the smallest adapter and make the tests pass; trace every
      discovery and install caller and adjust meaningful network tests.
- [x] Run focused regression, type/lint checks and a real GitHub skill lifecycle.
- [ ] Package, sign and upgrade E drive with user-state preservation; verify the
      installed catalog and selected-skill lifecycle before release work resumes.

## Ledger

- User approved proceeding. Selection refined from VoltAgent to AAS after
  inspection showed VoltAgent has no structured catalog and n-skills has only
  five entries. Existing work branches are task checkouts; build paths remain
  canonical because the Windows product pipeline uses them as verified inputs.
- Verified upstream blob 0b2b21b1401d978d2e97c1590bfe791971cda9bf at commit
  b7f6ad814a903f912962ea3cccad8c02766f753b. Snapshot has 2,871 supported names.
- Slow-network ruling: return a labeled snapshot after 500 ms while one bounded
  90-second online read continues, then use the validated result for later
  queries. Individual skill downloads retain the 20-second network boundary.
- Root repository tree reads were several MiB and failed on this network.
  Verified GitHub's commit:path tree API and switched AAS installs to the
  selected subtree. Existing non-AAS IDs retain their original resolution.
- 23 focused unit/registry regressions passed; type and lint checks passed.
  Full extension package build passed and all three attribution files are in
  the VSIX. Real GitHub catalog/search/paging and selected-skill install/readback/
  duplicate-protection/removal tests passed. The separate MCP npm network test
  failed during npm install; its isolated retry subsequently passed in 181 s.
  The signed 777,616,805-byte installer was applied in place with exit 0 and
  preserved-user-state comparison PASS. Installed files match the VSIX; all four
  MCPs passed the installed self-test. Full core regression: 6,245 passed,
  28 skipped. Installed UI acceptance remains pending because Computer Use still
  refuses actions after the user's explicit resumption authorization. Current
  private-update request errors and OpenRouter HTTP 403 also remain open.
