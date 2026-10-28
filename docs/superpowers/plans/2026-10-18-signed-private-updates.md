# Signed Private Updates Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Deliver authenticated main and recovery updates using one compiled release trust anchor.

**Architecture:** Keep the native updater and encrypted GitHub provider. Add an independent extension full-installer recovery command. Both verify an Ed25519 release manifest before trusting its asset hashes.

**Tech Stack:** Existing TypeScript/Node crypto, Windows DPAPI, Python cryptography, Inno Setup.

**Spec:** `maintenance/release-signing/SPEC.md`

## Global Constraints

- Keep repository private; no PAT or private signing key in source or installers.
- Public version 2.0, desktop 2.0.0, extension 0.1.11; work on existing master.
- Official signatures are mandatory in both channels; retain native quit veto.
- Preserve user projects, runtime, authentication, and signing credentials during source cleanup.

## Review Focus

- Modified JSON or wrong signature/key must fail before consuming asset hashes.
- CDN redirects must never receive the GitHub Authorization header.
- A same-account bad PAT must not silently override a selected OAuth session.
- Quit veto, active tasks, cancellation and UAC cancellation must not trigger installation.
- Same-version repair is allowed; product downgrade and compatibility-version confusion are rejected.

### Task 1: Signing and trust anchor

Files: create `maintenance/release-signing/sign-release.py`, `test_sign_release.py`,
`release-trust.json`; generated constants in desktop `src/vs/platform/update/common/releaseTrust.ts`
and core `src/services/update/releaseTrust.ts`.

Interface: `RELEASE_PUBLIC_KEY_SPKI_BASE64`, `RELEASE_PUBLIC_KEY_SHA256`; raw JSON and signature specified above.

- [ ] RED: test DPAPI round trip/tampering, manifest signing/tampering, wrong key and asset hashing.
- [ ] Implement create-only protected-key initialization and signed manifest production from actual files.
- [ ] GREEN: run unittest; independently verify the public signed fixture with Node crypto.
- [ ] Review and commit public inputs only; private key stays outside source.

### Task 2: Native main updater and Token entry

Files: existing GitHub provider flows, `githubUpdate*.ts`, update contribution, tests.

- [ ] RED: signature/tag/asset failures, PAT versus OAuth selection, redirect authentication.
- [ ] Reuse encrypted `github.auth`; add explicit classic-PAT entry and signed manifest validation.
- [ ] Offer `octocode.recoverDesktopUpdate` on explicit update failure.
- [ ] GREEN: real crypto and transport tests, provider tests, types and actual compiled client.
- [ ] Review and commit.

### Task 3: Independent extension recovery

Files: core `src/services/update/`, command registration/contributions, narrow runtime idle barrier, tests.

- [ ] RED: signed official VSIX validation; installer streaming, cancellation, downgrade and quit-veto cases.
- [ ] Reuse GitHub sessions, stream and verify full installer; wait for the real process to exit before launching it.
- [ ] GREEN: lifecycle tests with fake installer, no credential argv or global process killing.
- [ ] Review and commit.

### Task 4: Release and installed acceptance

- [ ] Rebuild actual VSIX/desktop/installer and verify legal payloads, hashes and signatures.
- [ ] Publish signed assets to the private release; read them back through authenticated API.
- [ ] Exercise real primary/recovery installation, cold start, persistence and source independence.
- [ ] Push reviewed master and confirm remote availability before authorized local-source cleanup.
