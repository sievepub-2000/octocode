# Third-Party Notices

Octocode bundles or depends on the following third-party open-source
projects. We are grateful to their authors and maintainers. This file
satisfies clause 4(d) of the Apache License, Version 2.0 for components
that ship a NOTICE.

The list below covers user-visible runtime dependencies. The exact
versions are pinned in `Cargo.toml` (Rust crates) and
`ui-shell/index.html` (CDN-loaded browser assets).

## Browser / WebUI assets (loaded via CDN at runtime)

| Project | License | Upstream |
| --- | --- | --- |
| marked | MIT | https://github.com/markedjs/marked |
| highlight.js | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| KaTeX | MIT | https://github.com/KaTeX/KaTeX |
| IBM Plex Mono | SIL OFL 1.1 | https://github.com/IBM/plex |
| Zen Kaku Gothic New | SIL OFL 1.1 | https://fonts.google.com/specimen/Zen+Kaku+Gothic+New |

## Rust crates (selected; full list in `Cargo.lock`)

| Crate | License | Purpose |
| --- | --- | --- |
| tokio | MIT | async runtime |
| reqwest | MIT OR Apache-2.0 | HTTP client used by provider transports |
| serde, serde_json | MIT OR Apache-2.0 | serialization |
| axum | MIT | WebUI HTTP server |
| clap | MIT OR Apache-2.0 | CLI parsing |
| anyhow, thiserror | MIT OR Apache-2.0 | error handling |
| tracing, tracing-subscriber | MIT | structured logging |
| rusqlite | MIT | session persistence |
| tokio-stream, futures | MIT OR Apache-2.0 | streaming SSE |

## Provider protocols

Octocode interoperates with — but does not vendor or redistribute — the
public APIs of the following providers. The names and trademarks of
these services belong to their respective owners and Octocode does not
claim affiliation:

- Anthropic Claude (anthropic.com)
- OpenAI / Azure OpenAI (openai.com / azure.microsoft.com)
- Google Gemini (ai.google.dev)
- xAI Grok (x.ai)
- OpenRouter (openrouter.ai)
- Zhipu GLM (open.bigmodel.cn)
- Moonshot Kimi (kimi.moonshot.cn)
- Alibaba Qwen (dashscope.aliyun.com)
- MiniMax (api.minimax.chat)
- NVIDIA build (build.nvidia.com)
- Xiaomi MiAI

## Skill / framework inspirations

The `skills/` tree contains Octocode-local instruction overlays that
adapt or reference upstream methodology projects. Where applicable,
upstream attribution and the original license are preserved inside the
respective subdirectory.

If you believe a project that Octocode depends on is missing from this
file, please open an issue or send a pull request.
