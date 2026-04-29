# Release Notes — Octocode v2026.4.29

Release date: 2026-04-29
License: Apache License 2.0
Repository: https://github.com/sievepub-2000/octocode

## Summary

Octocode v2026.4.29 is the first publicly-released build distributed under
the Apache License, Version 2.0. It consolidates the runtime, provider, and
WebUI improvements made between 2026-04-24 and 2026-04-29 into a single,
release-grade snapshot.

This release is intended to be installable, runnable, and verifiable on
Windows, macOS, and Linux from the GitHub source tree.

## Highlights

### Runtime

- Per-turn `session.model` resolution: each conversation now sticks to the
  exact model recorded on the session, even after the user switches the
  default model elsewhere in the UI.
- New `stub_fallback_active` snapshot field exposed by the runtime so the
  WebUI can surface a clear warning when every provider failed and a local
  stub is echoing replies. The CLI and Canvas shells consume the same flag.
- One-key start/stop scripts (`scripts/octocode-up.ps1`,
  `scripts/octocode-down.ps1`) that clean up zombie `octocode-cli` and
  `msedge` debug instances before launching the WebUI.

### Providers

- Anthropic transport now reads `ANTHROPIC_AUTH_TOKEN` as a third fallback
  after `ANTHROPIC_API_KEY` and `OCTOCODE_ANTHROPIC_API_KEY`. Many users
  in the Claude Code / claw-code ecosystem only set the auth-token form
  paired with a custom `ANTHROPIC_BASE_URL` gateway; the runtime can now
  reach those gateways out of the box.
- Anthropic requests send both `x-api-key` and `Authorization: Bearer` on
  the same call. Canonical Anthropic ignores `Authorization`; many third-
  party proxies (for example `ai.jiexi6.cn`) require the bearer form.

### WebUI

- LaTeX/KaTeX math rendering. Replies that contain `$...$`, `$$...$$`,
  `\(...\)`, or `\[...\]` are now rendered as proper formulas. Code fences
  remain literal.
- Localized Help menu: License, Release Notes, Privacy Statement, Check for
  Updates, Contact Us, About — each entry shows full content in the right
  panel.
- Help → Check for Updates now actually queries the GitHub Releases API for
  the upstream repository and reports whether the running build is current.
- Help → Contact Us shows the official email addresses
  (`sievepub@outlook.com`, `3925447879@qq.com`) and the public repo URL.
- Default UI language is English. Japanese, Korean, and Simplified Chinese
  remain fully supported and switchable at runtime via View → Language.

### Documentation

- `LICENSE` (Apache 2.0) and `NOTICE` files added at the repository root.
- `docs/PRIVACY.md`, `docs/release-notes-2026-04-29.md`,
  `docs/THIRD_PARTY_NOTICES.md`, `docs/modules/index.md`, plus a per-module
  English + Japanese guide under `docs/modules/`.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` added at the
  repository root with `.github/` issue and pull-request templates.

## Known Limitations

- Throughput against the `ai.jiexi6.cn` proxy is currently bounded by the
  upstream chain (~4 tokens / second observed). This is not an Octocode
  bottleneck.
- The desktop installer scripts under `scripts/package-*` have only been
  smoke-tested on Windows for this release.

## Upgrading

If you ran an earlier development build, stop the previous WebUI before
upgrading:

```powershell
.\scripts\octocode-down.ps1 -All
git pull
cargo build --release -p octocode-cli
.\scripts\octocode-up.ps1 -Port 999 -SessionId main -NoBuild
```

## License

Octocode is distributed under the Apache License, Version 2.0. The full
text is shipped at the repository root as `LICENSE` and inside the WebUI
under Help → License.
