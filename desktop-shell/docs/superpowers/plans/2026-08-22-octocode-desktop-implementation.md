# OctoCode Desktop Implementation Plan

**Goal:** Ship a standalone OctoCode desktop and CLI on machine 3, preserve legacy conversations through a one-shot migration, use machine 2 Qwen3.8 through SGLang, and provide native, Responses, and XML tool protocols plus browser and desktop MCP capabilities.

**Architecture:** Keep the existing VS Code/Electron shell and existing agent task loop. Add adapters at existing provider, parser, terminal, MCP, skills, and startup seams. Every automated entry point uses the same task store, canonical tool call, and executor.

**Stack:** TypeScript, Electron/VS Code 1.132, React webview, Node 22, pnpm, Vitest, MCP SDK, official pinned `@playwright/mcp`; one lazy platform desktop MCP process.

## Phase 1: Branding and authoritative data migration

- Rename product metadata, executable, CLI, extension ID, commands, views, settings, URI scheme, install assets, and user-facing strings to OctoCode.
- Add a one-shot migration from legacy user-data and extension storage namespaces, with a marker, count verification, representative history read-back, and no permanent dual-read.
- Preserve unrelated existing changes in both repositories.
- Tests: manifest snapshots, migration idempotency, failure rollback, forbidden-brand scan over shipped assets.

## Phase 2: Canonical provider and tool protocols

- Introduce one canonical tool-call/result type at the existing assistant-message boundary.
- Keep native tool calls as the normal path; adapt Responses events and restore a bounded XML parser as input adapters only.
- Implement capability resolution and cache: explicit override, known metadata, one probe, one fallback, task lock.
- Prevent a logical call from executing twice during protocol fallback or resume.
- Fix Responses endpoint normalization for configured `/v1` URLs.
- Tests: three protocol fixtures, streaming partials, malformed input, exactly-once, resume lock, fallback ceiling, Qwen registry limits.

## Phase 3: Structured shell executor

- Replace automatic prompt/shell-integration completion detection with a shared child-process executor.
- Use argv for exact executables; PowerShell EncodedCommand; non-interactive bash/zsh; UTF-8 NDJSON event framing; separate stdout/stderr and real exit status.
- Keep the VS Code terminal as an optional secondary display only.
- Tests: Windows PowerShell and portable shell matrix covering dollar signs, backticks, quotes, pipes, multiline input, Chinese, emoji, timeout, cancellation, and non-zero exit.

## Phase 4: Durable harness and CLI parity

- Formalize existing task lifecycle states and persist checkpoints at tool boundaries.
- Route desktop and CLI through the same cancellation, resume, tool queue, profiles, MCP, skills, and event stream.
- Productize the existing CLI as `octocode`; add Windows packaging and `doctor`, model test, MCP test, skills list, and protocol probe commands.
- Tests: crash/restart recovery, cancellation, follow-up, concurrent-output ordering, CLI/Desktop parity.

## Phase 5: Browser workspace and browser MCP

- Bundle a pinned official `@playwright/mcp`; lazy-start it with a workspace-scoped persistent profile.
- Reuse the existing browser editor/Electron surface and connect the managed session through CDP.
- Surface accessibility snapshots, actions, console/network evidence, downloads, screenshots, and human takeover in the task timeline.
- Add optional static Scrapling extraction only if Playwright snapshot/token tests show a measurable need.
- Tests: navigation, forms, tabs, persistent login state, download, extraction, restart, MCP crash recovery, idle shutdown.

## Phase 6: Desktop automation MCP

- Add a platform-neutral MCP schema for observe, windows, elements, click, type, keys, scroll, wait, screenshot, and application launch/focus.
- Implement Windows UI Automation/Win32 first; keep Linux AT-SPI and macOS AX adapters behind the same boundary.
- Prefer semantic references; allow coordinates only as an explicit fallback.
- Tests: isolated Windows application CRUD-like interaction and read-back; adapter contract tests for Linux/macOS; clear no-vision behavior for Qwen.

## Phase 7: Default skills

- Seed pinned Ponytail and Superpowers distributions through the existing skills store without a second plugin runtime.
- Preserve modified user copies and expose source/version/status.
- Tests: first install, idempotent restart, update without overwrite, CLI/UI visibility.

## Phase 8: Agent-first desktop shell

- Default to Agents Window, open OctoCode as the primary surface, remove login/account gates, and expose local model settings permanently.
- Retain files, diffs, source control, language services, editor, and terminal as secondary surfaces without IDE-first chrome.
- Add model transport/tool-protocol auto status and test connection UI.
- Tests: cold start signed out, single primary surface, local profile CRUD, secondary surfaces, reload/restart, no login requirement.

## Phase 9: Build, deploy, and acceptance

- Build extension, CLI, VS Code/Electron shell, installers, and shortcuts.
- Stop the current app, deploy in place, migrate data, and restart through system/desktop launch paths.
- Run CLI acceptance first, then live SGLang three-protocol tests, browser tests, desktop tests, restart persistence, process/config/data-source audit, resource/idle audit, and forbidden-brand scan.
- Invite user for final UI interaction testing; record verified facts separately from unexecuted Linux/macOS runtime claims.
