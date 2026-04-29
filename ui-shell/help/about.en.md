# About Octocode

Octocode is an open-source local coding agent: a Rust runtime, a
single-page WebUI, and a desktop shell that brokers chat between you
and the LLM provider of your choice (Anthropic, OpenAI, Gemini, xAI,
OpenRouter, GLM, Kimi, Qwen, MiniMax, NVIDIA, Xiaomi, or any
OpenAI-compatible local server). The project is licensed under the
**Apache License, Version 2.0**.

- Version: **2026.4.29**
- Repository: <https://github.com/sievepub-2000/octocode>
- License: Apache 2.0 (Help → License for the full text)
- Default language: English. Switchable to Japanese / Korean / Chinese from
  View → Language.

## Architecture in one paragraph

`octocode-core` owns stable domain types. `octocode-api` owns
provider wire behavior. `octocode-runtime` orchestrates sessions,
permissions, and routing. `octocode-cli` boots the WebUI HTTP server
and the CLI. The browser shell and the desktop shell consume runtime
events and snapshots only.

For the full module reference see:

- [`docs/modules/index.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/index.md)
  (entry point, EN + JA links)
- [`docs/modules/octocode-modules.en.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/octocode-modules.en.md)
  (English consolidated reference)
- [`docs/modules/octocode-modules.ja.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/octocode-modules.ja.md)
  (Japanese consolidated reference)

## Acknowledgements (third-party projects)

Octocode would not exist without the work of these upstream projects.
Thank you to every author, maintainer, and contributor.

**Browser / WebUI**: marked (MIT) · highlight.js (BSD-3-Clause) ·
KaTeX (MIT) · IBM Plex Mono (SIL OFL 1.1) · Zen Kaku Gothic New
(SIL OFL 1.1).

**Rust runtime**: tokio · reqwest · serde · serde_json · axum ·
clap · anyhow · thiserror · tracing · tracing-subscriber · rusqlite ·
tokio-stream · futures.

**Provider protocols** (used as documented public APIs; trademarks
belong to the respective owners): Anthropic Claude · OpenAI / Azure
OpenAI · Google Gemini · xAI Grok · OpenRouter · Zhipu GLM · Moonshot
Kimi · Alibaba Qwen · MiniMax · NVIDIA build · Xiaomi MiAI.

**Method skills** (instruction overlays bundled under `skills/`):
spec-kit · vibecoding-guide · get-shit-down · autoresearch ·
agent-customization · agent-skills · find-skill · canvas-design ·
naive-ui · pentagi · penpot · andrej-karpathy-skills, and others —
see the per-folder `SKILL.md` for upstream attribution.

The full third-party list and licenses are tracked in
[`docs/THIRD_PARTY_NOTICES.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/THIRD_PARTY_NOTICES.md).

## Documentation

| Topic | Link |
| --- | --- |
| Module reference | [docs/modules/index.md](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/index.md) |
| Release notes | [docs/release-notes-2026-04-29.md](https://github.com/sievepub-2000/octocode/blob/master/docs/release-notes-2026-04-29.md) |
| Privacy statement | [docs/PRIVACY.md](https://github.com/sievepub-2000/octocode/blob/master/docs/PRIVACY.md) |
| Contributing | [CONTRIBUTING.md](https://github.com/sievepub-2000/octocode/blob/master/CONTRIBUTING.md) |
| Security policy | [SECURITY.md](https://github.com/sievepub-2000/octocode/blob/master/SECURITY.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](https://github.com/sievepub-2000/octocode/blob/master/CODE_OF_CONDUCT.md) |
| Architecture | [docs/architecture.md](https://github.com/sievepub-2000/octocode/blob/master/docs/architecture.md) |

## Contact

`sievepub@outlook.com` · `3925447879@qq.com` · or via the issue
tracker. See Help → Contact Author for direct links.
