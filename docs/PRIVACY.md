# Privacy Statement — Octocode

Effective date: 2026-04-29
Applies to: Octocode v2026.4.29 and later, distributed under the Apache
License, Version 2.0.

## 1. What Octocode is

Octocode is an open-source local CLI / WebUI / desktop coding agent. It
runs on the user's own machine and brokers chat traffic between the user
and external Large Language Model (LLM) providers that the user
configures (for example Anthropic, OpenAI, Gemini, OpenRouter, GLM, and
local OpenAI-compatible gateways).

The Octocode project itself does **not** operate any backend service for
end users. There is no Octocode-owned cloud, no telemetry collector, and
no centralized account system.

## 2. Data Octocode handles locally

When Octocode runs on a user's machine it processes the following data,
all of which stays on that machine unless the user explicitly transmits
it elsewhere:

- Chat messages typed into the WebUI / CLI / Canvas shell.
- Tool execution arguments (file paths, shell commands, search queries).
- Session metadata: session id, model id, provider id, timestamps.
- Provider configuration: provider id, base URL, default model,
  permission mode, history limit.
- Optionally, GitHub credentials (PAT / fine-grained PAT / OAuth /
  GitHub App installation token / Basic / Deploy Key) entered into the
  Manage → GitHub panel. These credentials are stored in the browser's
  `localStorage` for the WebUI and never written to the runtime backend.
- Files inside the user-selected workspace, when a tool is invoked
  against them.

## 3. Data sent to third parties

When the user sends a chat message, Octocode forwards the message — and,
depending on the requested tool, related context (files, command output,
session history) — to the provider endpoint that the user has selected.
This transfer is direct from the user's machine to the provider, over
HTTPS.

The privacy practices of those providers are governed by the provider's
own privacy policy, not by this document. Users are responsible for
choosing providers whose policies they accept.

If the user enables a custom `ANTHROPIC_BASE_URL` (or equivalent OpenAI /
Gemini / OpenRouter base URL) the request goes to that gateway instead
of the canonical provider endpoint. Octocode does not inspect, log,
re-route, or persist this traffic on any Octocode-controlled
infrastructure.

## 4. Data Octocode does not collect

Octocode does not:

- Send telemetry, crash dumps, or usage analytics to any
  Octocode-operated server.
- Read or upload files outside the user-selected workspace.
- Capture keyboard, screen, microphone, or camera input.
- Phone home for license enforcement.
- Maintain a remote account, profile, or identity for the user.

The only outbound network calls Octocode initiates are:

- The LLM provider endpoint that the user has configured.
- The GitHub Releases API for the upstream repository, when the user
  clicks Help → Check for Updates.
- The CDN-hosted assets referenced by `ui-shell/index.html`
  (`marked`, `highlight.js`, `KaTeX` from `cdnjs.cloudflare.com`,
  Google Fonts). Users may self-host these assets to avoid CDN calls.

## 5. Local storage

The runtime persists session and configuration data under the user's
local config directory (Windows: `%APPDATA%\octocode`,
macOS / Linux: `~/.config/octocode` or `$XDG_CONFIG_HOME/octocode`).
The user fully controls these files and may delete them at any time.

The WebUI persists the selected language, color scheme, and GitHub
credentials in `localStorage` of the browser running on `127.0.0.1`.
Clearing the browser's site data removes them.

## 6. Children's privacy

Octocode is a development tool. It is not directed at children under 13
and does not knowingly collect data from children.

## 7. Changes to this statement

This statement may be updated as new features are added. Changes are
recorded in `CHANGELOG.md` alongside the corresponding code changes.
The "effective date" line at the top is updated whenever the substantive
content changes.

## 8. Contact

For privacy-related questions, contact the author at:

- sievepub@outlook.com
- 3925447879@qq.com

The repository's public issue tracker is also acceptable for
non-confidential privacy questions:
<https://github.com/sievepub-2000/octocode/issues>.
