# OctoCode Standalone Agent Desktop Design

## 1. Goal

Turn the current distribution into a standalone OctoCode desktop product. The existing agent engine is the primary user experience. The VS Code 1.132 workbench remains the application kernel for extension hosting, files, editors, diffs, terminals, source control, language services, and process execution, but the conventional IDE chrome is not the default user interface.

The product must start without GitHub or Agent Core cloud authentication, expose local model configuration directly, preserve existing Agent Core conversations and settings, and run the existing local SGLang Responses API profile by default.

## 2. Product Invariants

- OctoCode starts in the Agents Window for normal desktop launches on Windows, Linux, and macOS.
- Agent Core is bundled as one built-in extension. A second user-installed Agent Core copy must not be active.
- No GitHub, Copilot, or Agent Core cloud account is required to open the agent, configure a local model, run tools, or continue an existing conversation.
- The current Agent Core task history, provider profiles, and secrets remain authoritative and survive the migration and restart.
- Agent Core remains the owner of agent execution, tool approval, task history, modes, MCP, terminal commands, and model-provider behavior.
- VS Code remains the owner of windows, extension hosting, workspace/files, editors, diffs, terminal processes, language services, source control, and native platform integration.
- Core integration code is TypeScript and uses existing VS Code services or extension APIs. Runtime behavior must not depend on PowerShell, WScript, synthetic mouse/keyboard input, window-title matching, sleeps, or OS-specific filesystem paths.
- The existing broad command policy is preserved: `allowedCommands: ["*"]`, an empty deny list, and no command timeout.
- Classic workbench access remains available through an explicit maintenance CLI switch, but it is not the default desktop experience.
- All user-visible product names, executable names, commands, configuration pages, logs, installers, shortcuts, extension metadata, and documentation use `OctoCode`. Legacy product names are permitted only inside a one-shot migration map and are never displayed after migration.
- There is exactly one agent task loop. Desktop, browser, CLI, model protocols, MCP, and skills feed the same task state machine and tool queue.

## 3. Chosen Architecture

### 3.1 Existing Agents Window as the application shell

OctoCode uses the existing `vs/sessions` Agents Window. It already supplies a separate Electron workbench with simplified chrome, no activity bar, no status bar, a compact title bar, modal editors, terminal support, and session-oriented layout.

A OctoCode-specific product configuration block identifies:

- whether desktop launches default to the Agents Window;
- the primary built-in extension ID;
- the command that opens the primary agent surface;
- the command that opens local model settings;
- whether the Agents Window shares the default user profile.

The product block is read through `IProductService`; no brand-name checks or platform checks are used.

### 3.2 Existing agent engine as the primary surface

The existing tab webview remains the only agent UI implementation. It is rebranded and productized as OctoCode rather than copied into a second React application or wrapped in a new Electron process.

A small contribution under `vs/sessions/contrib/octoCode/` waits for installed extensions to be registered and then executes Agent Core's primary-surface command. Command execution activates the built-in Agent Core extension through the normal extension lifecycle. The resulting webview editor is presented as the persistent main surface of the Agents Window.

The contribution owns only shell behavior:

- open the primary surface at cold start;
- restore it if no primary surface exists after reload;
- avoid duplicate panels;
- expose a title-bar action for local model settings;
- log an actionable error if the bundled extension or command is unavailable.

It does not own model state, conversations, terminal execution, or agent orchestration.

Agent Core's existing single-open invariant remains authoritative. The primary-surface command reuses `openClineInNewTab()` and focuses the existing panel when one already exists.

### 3.3 VS Code capabilities as secondary surfaces

The normal Agents Window editor, changes/file views, source control integration, and terminal panel remain available. Agent Core can open files, diffs, terminals, and command output through the existing VS Code API.

The default layout is agent-first:

- compact OctoCode title bar;
- Agent Core webview filling the main content area;
- IDE sidebars and panels hidden initially;
- files, diffs, and terminal revealed only on explicit user or agent action;
- closing a secondary editor returns focus to Agent Core;
- closing Agent Core exposes a recovery action rather than a GitHub/Copilot welcome screen.

No CSS-only fake shell is used. Visibility and restoration are controlled through the existing workbench layout and editor services.

## 4. Startup and Cross-Platform Behavior

The default-window decision is implemented once in the Electron main-process startup path using product configuration and parsed CLI arguments.

- `OctoCode` with no maintenance override opens the Agents Window.
- `OctoCode --agents` explicitly opens the Agents Window.
- `OctoCode --workbench` opens the classic workbench for maintenance.
- Folder/workspace arguments are forwarded to the Agents Window as the selected working folder.
- Protocol/deep-link handling keeps its existing precedence and validation.

Because this decision is inside the TypeScript/Electron startup path, the same executable behavior applies to Windows shortcuts, Linux `.desktop` launchers, and the macOS application bundle. Packaging does not need an OS-specific wrapper to select Agent mode.

The Windows desktop and Start Menu shortcuts on machine 3 will be refreshed to point to the installed OctoCode executable. The executable itself defaults to Agent mode, so shortcut arguments are not the source of truth.

## 5. Authentication and Copilot Removal

OctoCode removes GitHub Copilot as its default chat agent and removes `GitHub.copilot-chat` from built-in auto-update configuration. Copilot trusted-auth declarations and Agents Window account/sign-in contributions are omitted from the OctoCode product.

VS Code services that currently assume `defaultChatAgent` is always present are made null-safe. With no default chat agent:

- the default-account service becomes an inert no-account service;
- the sessions setup flow completes without showing authentication;
- the title bar does not register the Sign In account widget;
- Copilot entitlement and welcome flows do not start.

Generic authentication APIs remain available for independently installed extensions. OctoCode removes the forced default account, not the entire VS Code authentication subsystem.

Agent Core cloud providers remain selectable only as optional providers. They do not gate startup, settings, local profiles, history, or local execution. No background cloud login flow is initiated for an `openai-native` profile.

## 6. Packaging, Branding, and Profile Ownership

The agent extension is renamed to `OctoCode.octocode-core`, packaged under the application built-in extensions directory, and removed from the OctoCode user extensions directory after deployment verification. Its display name, commands, views, settings, URI scheme, telemetry labels, CLI name, and documentation use OctoCode naming.

The Agents Window uses the existing default OctoCode user profile rather than creating a separate Agents Window profile. This keeps the existing authoritative locations for:

- `OctoCode.octocode-core` global state;
- SecretStorage entries;
- task-history metadata and task files;
- provider profiles;
- current model selection;
- existing user settings.

A one-shot migration imports the current task history, provider profiles, settings, secrets, and workspace state into the OctoCode namespace. It writes a migration marker, verifies record counts and representative task reads, and then makes the OctoCode store authoritative. No permanent dual-read or synchronization layer is introduced.

## 7. Explicit Local Model Configuration

The Agents Window title bar includes a permanent `Local Model Settings` action. It executes Agent Core's settings command. If the Agent Core panel is absent, Agent Core first creates/focuses the primary panel and then opens settings. The command must never be a silent no-op.

The settings surface exposes and persists:

- profile name;
- provider/protocol;
- Base URL;
- API key through SecretStorage;
- model ID, including custom IDs;
- context window;
- maximum output tokens;
- reasoning support and selected effort;
- temperature, verbosity, image, and prompt-cache capability flags where applicable.

The existing `ProviderSettings`, `ModelInfo`, `openAiCustomModelInfo`, `SettingsView` cached-state flow, and `ProviderSettingsManager` remain the data path. No parallel OctoCode settings database is added.

For known models, registry metadata supplies defaults. Explicit per-profile overrides win. Invalid numeric limits are rejected before save. Unknown custom models require explicit positive context and output-token values instead of silently inheriting unrelated OpenAI defaults.

The existing profile remains preselected:

```text
Profile: Local SGLang Responses
Provider: openai-native
Base URL: http://192.168.10.2:8000/v1
Model: qwen3.8-27b
Context window: 262144
Max output tokens: 32768
Reasoning efforts: low, medium, xhigh
Selected effort: xhigh
```

## 8. Responses API Robustness

OpenAI Native remains the Responses API provider. A single endpoint-normalization function constructs the manual SSE fallback endpoint:

- `http://host:8000` becomes `http://host:8000/v1/responses`;
- `http://host:8000/` becomes `http://host:8000/v1/responses`;
- `http://host:8000/v1` becomes `http://host:8000/v1/responses`;
- `http://host:8000/v1/` becomes `http://host:8000/v1/responses`.

The SDK path continues receiving the configured SDK base URL unchanged. Only the manual fallback endpoint is normalized. This prevents `/v1/v1/responses` without altering working SDK behavior.

Provider errors shown to the user include the provider, model ID, normalized endpoint, HTTP status, and response body when safe. API keys are never logged.

## 9. Canonical Model and Tool Protocol Layer

OctoCode normalizes every provider response into one internal `CanonicalToolCall` representation. OpenAI Chat Completions `tool_calls`, OpenAI Responses `function_call`, and legacy XML tool markup are transport adapters only; all three feed the existing typed validation, approval, MCP, execution, result, and persistence path.

Protocol selection uses this precedence: explicit profile override, cached capability record, provider metadata, one bounded capability probe, then a safe fallback. A task locks its selected protocol for its lifetime. Only an explicit unsupported-protocol response permits one fallback retry, and the same logical tool call cannot execute twice.

The SGLang profile defaults to Responses API function calls, falls back once to Chat Completions tool calls, and uses XML only for models that cannot emit either native format. Provider families include OpenAI Responses, OpenAI Chat Completions and compatible servers, Anthropic Messages, Google Gemini, Azure OpenAI, Ollama, and LM Studio without adding a second gateway service.

## 10. Agent Harness and Durable Execution

The existing task loop remains the only harness. It gains explicit lifecycle states, durable per-turn checkpoints, cancellation propagation, restart recovery, and a single serialized tool-consumer path. Desktop UI and CLI subscribe to the same event stream and resume the same task records.

No complete external harness is embedded. Useful lifecycle and adapter concepts are adopted without importing a competing task loop, provider registry, context compressor, or permission system.

## 11. Structured Cross-Platform Command Execution

Automatic commands never depend on prompt text such as `$`, `>`, or `PS>` to detect completion. They use process exit, separate stdout/stderr streams, and an exit record. Command requests are structured data containing shell, command, cwd, environment, timeout, and encoding.

- Windows selects `pwsh` when available and otherwise Windows PowerShell. PowerShell commands use UTF-16LE Base64 `EncodedCommand` with `-NoLogo -NoProfile -NonInteractive`.
- Linux uses `bash --noprofile --norc`.
- macOS uses `zsh -f`.
- Exact executable tools bypass a shell and use argv directly.
- All harness framing is UTF-8 NDJSON; no shell is nested inside another shell to transport the command.

The interactive terminal remains available as a secondary UI, but automatic tool execution uses the structured executor. The existing full-access command policy is preserved.

## 12. Built-In Browser and Browser MCP

OctoCode exposes a browser workspace inside the Agent desktop. It reuses the existing Electron/VS Code browser surface and connects the official `@playwright/mcp` package to the same managed Chromium session through CDP. Browser state is persistent per workspace, and observation uses accessibility snapshots before screenshots.

Browser navigation, clicks, typing, forms, tabs, downloads, console, network evidence, screenshots, and human takeover are shown in the task timeline. The browser service starts on first use and stops after an idle period. A pinned version is bundled; runtime does not use `npx @latest`.

Scrapling is an optional lazy static-extraction service for compact article, table, and link extraction. It does not start its dynamic browser when the managed Playwright session already exists. Crawl4AI and a second browser-agent loop are not included because they duplicate the browser runtime and orchestration path.

## 13. Desktop Automation MCP

OctoCode includes one lazy local desktop MCP service with a platform-neutral tool schema. Observation returns active application, window tree, accessible control roles, names, states, bounds, and optional screenshots. Actions target stable semantic element references; coordinates are a last-resort fallback.

- Windows adapter: UI Automation and Win32, with optional application-native automation such as COM.
- Linux adapter: AT-SPI.
- macOS adapter: Accessibility/AX APIs.

The service follows the semantic-observation-first architecture used by mature AI+RPA systems and Microsoft UFO, but does not copy a closed product or embed UFO's agent loop. Platform adapters are isolated behind the MCP process boundary and start only when desktop tools are called.

Because the current Qwen model is text-only, accessibility-tree text is the authoritative observation. Screenshot-dependent actions must return a clear unsupported-capability result rather than guessing.

## 14. Default Skills

Pinned, license-compatible distributions of Ponytail and Superpowers are seeded through the existing Agent Skills mechanism and enabled by default. The Skills page shows version, source, status, and update availability. First-run seeding never overwrites user-edited copies, and host-specific hooks are adapted only where OctoCode has an equivalent lifecycle event.

No second plugin runtime is created.

## 15. Product CLI

The existing headless CLI is renamed and packaged as `octocode`. Windows, Linux, and macOS use the same task loop, model profiles, MCP registry, skills, conversation store, and structured command executor. Stable commands cover chat/run, resume, model list/test, MCP list/test, skills, protocol probe, and doctor. Print mode supports text, JSON, and streaming NDJSON for automated acceptance tests.

## 16. Failure Handling

- Missing bundled Agent Core: show a OctoCode product error with a retry action and log the missing extension ID.
- Missing primary command: show a product error after extension registration, not an unhandled rejected promise.
- Invalid local profile: open Local Model Settings with validation errors; do not redirect to login.
- Unreachable SGLang: keep the conversation and input intact and show a retryable connection error.
- Agent Core panel crash/reload: the extension's serializer and retained context restore the panel; shell recovery avoids creating duplicates.
- Secondary editor or terminal failure: report through existing VS Code notification/output services while Agent Core remains usable.
- Classic workbench maintenance mode never changes or migrates Agent Core storage independently.

## 17. Test Strategy

### VS Code unit and integration tests

- startup decision: default Agent mode, explicit `--agents`, explicit `--workbench`, and protocol precedence;
- no-default-chat-agent account service behavior;
- OctoCode shell contribution activates the primary command once and handles missing commands;
- title-bar model-settings action executes the configured command;
- Agents Window selects the default user profile in OctoCode product mode;
- classic non-OctoCode/product-default behavior remains unchanged.

### Agent Core tests

- settings command opens/focuses Agent Core before navigating to settings;
- known model metadata renders correctly;
- custom model information saves through cached state and reads back;
- unknown model validation rejects missing/invalid context and output limits;
- OpenAI Native consumes explicit model overrides;
- fallback endpoint normalization covers all trailing-slash and `/v1` cases;
- no Agent Core/GitHub authentication state is required for `openai-native`.
- canonical conversion and exactly-once execution for Responses, Chat Completions tool calls, and XML;
- deterministic auto-detection, cached selection, one-time fallback, and task protocol locking;
- checkpoint, cancellation, restart resume, and malformed tool-call recovery;
- structured shell tests for dollar signs, backticks, quotes, pipes, multiline commands, Chinese text, emoji, and non-zero exits;
- CLI parity for model, MCP, skills, history, and tool execution;
- Playwright MCP lifecycle, persistent profile, accessibility snapshots, downloads, and human takeover;
- desktop MCP semantic discovery, action, read-back, failure reporting, and idle shutdown;
- Ponytail and Superpowers first-run installation and no-overwrite upgrades;
- one-shot branding/data migration and absence of legacy product names in user-visible assets.

### Windows live acceptance on machine 3

- launch signed out through the desktop shortcut;
- confirm only the Agent desktop appears;
- confirm no GitHub/Agent Core login prompt or account spinner;
- open model settings from the title bar;
- create, save, select, read back, and delete an isolated temporary profile;
- confirm the existing `Local SGLang Responses` profile and old conversations remain;
- run a real Agent Core task against SGLang that invokes a tool, runs a CLI command, writes and reads a proof file, and continues through Responses API state;
- open a file/diff and terminal as secondary VS Code surfaces, then return to Agent Core;
- restart OctoCode and repeat profile/history/launch checks;
- inspect process executable, working directory, profile, extension locations, logs, and effective product configuration;
- confirm there is one authoritative Agent Core extension and one authoritative state store.
- run the complete CLI acceptance suite before UI acceptance;
- exercise browser navigation, form entry, download, extraction, restart persistence, and human takeover;
- exercise Windows desktop window discovery, semantic click, text input, state read-back, and failure recovery;
- verify processes, child services, idle shutdown, memory use, effective configuration, MCP registry, model protocol, and user-data ownership;
- scan installed binaries, manifests, UI strings, shortcuts, settings, and logs for forbidden legacy product branding.

Linux and macOS compatibility is established by shared TypeScript startup and product configuration, platform-neutral path/profile services, and successful compilation. This Windows deployment does not claim an unexecuted Linux or macOS runtime test.

## 18. Deployment

1. Build and test Agent Core.
2. Package Agent Core as a VSIX and embed it into the staged OctoCode application as a built-in extension.
3. Build and test the OctoCode/VS Code shell.
4. Stop the running OctoCode process.
5. Replace the installed application in place while preserving the existing OctoCode user-data directory.
6. Remove the duplicate user-installed Agent Core only after the built-in copy is verified.
7. Refresh Windows shortcuts.
8. Perform cold-start and live acceptance checks.

Deployment scripts are orchestration only and are not runtime dependencies. Runtime behavior must remain correct when OctoCode is installed by normal Windows, Linux, or macOS packaging.

## 19. Out of Scope

- Replacing the existing agent task loop with a second harness.
- Replacing SGLang, Qwen3.8-27B, or the current speculative-decoding configuration.
- Creating a second model database or conversation store.
- Reimplementing VS Code terminal, editor, Git, diff, or extension-host functionality.
- Removing optional non-local Agent Core providers from the provider selector.
- Claiming Linux or macOS runtime validation without running those platforms.
- Running multiple permanent browser engines or crawler services for overlapping work.
