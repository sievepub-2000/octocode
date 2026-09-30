# OctoCode Unified Development Environments, Browser, and Status Design

## Goal

Extend the existing OctoCode workbench without adding a second execution core. The product must route PowerShell 7, VS Code CLI, WSL, Docker, Java, Go, .NET/MSBuild, GCC/MSVC/Clang, Rust, Python, Swift, TypeScript, FFmpeg, Pandoc, Android, and remote iOS work through one visible environment model; expose complete browser automation through the existing upper-right BrowserView; restore the classic horizontal Windows menu; package the missing resource icons; and show unambiguous waiting, thinking, and executing states.

The fixed workbench topology remains:

`Activity Bar | management sidebar | agent chat | artifact/browser over terminal (75/25)`

This design supersedes the earlier compact-menu decision. It does not change the approved three-window output contract: model text stays in chat, artifacts and browser/file/media results stay upper-right, and terminal events stay lower-right.

## Architectural decisions

- Workbench remains the only environment-routing owner because it already owns VS Code terminals, profiles, extension commands, MCP configuration, and UI state.
- Reuse the existing `Terminal`, `ExecuteCommandTool`, BrowserView/CDP bridge, MCP manager, settings store, and VS Code menu/extension infrastructure. Do not create parallel executors, browsers, marketplaces, or environment databases.
- Route the existing `execute_command` text through one small selector configured by native VS Code settings. Keep the public tool schema unchanged so tool-calls, XML, and Responses API payloads remain compatible.
- Android and iOS are integrations, not core rewrites. Android uses the official command-line SDK/tooling. iOS uses a mature VS Code extension or MCP/SSH route to a configured macOS/Xcode host.
- The installed OctoCode CLI is canonical. A `code` compatibility shim may forward to it for extension/tool compatibility, while product identity and user-data isolation remain OctoCode.

## Unified environment registry and routing

Supported route identifiers are deliberately finite:

- `auto`
- `vscode-terminal`
- `pwsh`
- `wsl:<distribution>`
- `msvc`
- `docker:<context>`
- `android`
- `macos-remote`

Automatic routing follows observable task requirements:

1. Interactive commands and commands that must remain visible use the VS Code terminal.
2. Native Windows automation uses PowerShell 7.
3. Linux, GCC, and Docker Engine workloads use the selected WSL2 distribution.
4. `.sln`, `.vcxproj`, `cl`, and MSBuild workloads initialize the installed Visual Studio Build Tools environment before execution.
5. Android commands use the configured SDK/JDK paths.
6. Rust, Python, TypeScript, Java, Go, .NET, FFmpeg, and Pandoc use the visible native VS Code terminal because they need no shell bootstrap.
7. Swift/iOS/Xcode commands require `macos-remote`; no Windows fallback is allowed.

Native localized OctoCode settings expose the default route, WSL distribution, Docker context, MSVC developer script, and remote macOS SSH host. Secrets stay in the existing VS Code secret store. Logs record route selection and sanitized diagnostics, never tokens or credentials.

## Provisioning on machine 3

Install only missing components and keep one current supported version of each environment unit:

- PowerShell 7 latest stable.
- WSL2 with one lightweight distribution; enabling the required Windows features and rebooting is approved.
- Docker Engine inside WSL2 to avoid a second desktop shell and redundant VM management.
- Temurin JDK 25 LTS, current stable Go, and .NET 10 LTS.
- Reuse installed Visual Studio Build Tools, MSVC, Clang, and CMake; add only Ninja and WSL GCC if absent.
- Current stable FFmpeg and Pandoc.
- Keep the built-in TypeScript language service. Install the verified Open VSX language extensions for Rust, Python, Swift, Java, Go, .NET, PowerShell, Docker, Android/Gradle, Clang, and LLDB through OctoCode's standard extension interface.
- Android uses the Android/Gradle extensions and project Gradle wrapper first. Install the command-line SDK only when a real Android build requires it; do not install Android Studio by default.
- iOS uses the official Swift extension plus open-source SweetPad and the `macos-remote` route. Xcode compilation and simulator/device validation remain conditional on an actual reachable Mac.

All installers must be sourced from official release channels, use explicit versions where practical, expose version diagnostics, and be idempotent. A reboot checkpoint resumes from persisted plan state.

## Browser tools and validation

The upper-right BrowserView is the product browser. Extend its existing CDP bridge behind one `browser` MCP surface with actions:

`open`, `list`, `close`, `navigate`, `back`, `forward`, `reload`, `snapshot`, `click`, `fill`, `press`, `select`, `hover`, `wait`, `assert`, `screenshot`, `console`, `network`, and `evaluate`.

Use Playwright MCP with the installed Microsoft Edge as the standards-based fallback and deterministic validator. This avoids downloading another Chromium copy. Midscene remains the visual, mouse, and keyboard validation layer. Chrome DevTools MCP is not installed by default because native CDP plus Playwright already covers its role; it remains an optional diagnostic integration.

Browser actions publish results only to the upper-right artifact/browser area. Structured runtime events and terminal output continue to the lower-right terminal area.

## UI corrections

### Resource icons

The MCP Services, Skills, and AgentMods manifest icons currently point at files excluded from the packaged extension. Copy only the three required monochrome SVG assets into the already packaged `assets/icons/activity` directory and update manifest paths. Native Extensions keeps its existing VS Code icon. All four consecutive activity entries retain localized hover labels and accessible names.

### Classic menu

Restore the native horizontal menu at the top-left using the VS Code title/menu implementation. It must expose File, Edit, Selection, View, Go, Run, Terminal, and Help in the active locale. Remove the activity-rail hamburger duplicate and migrate the prior compact setting once without changing unrelated user layout choices.

### Unified phase indicator

Derive one visible phase from authoritative runtime events:

- Waiting for model…
- Thinking…
- Executing: `<tool>`…
- Waiting for confirmation…
- Waiting for subtask…
- Waiting for external service…

Reuse one progress-ring/animated-ellipsis component with reduced-motion support. Command execution begins at the command-start event, not after output arrives. Completion/error/cancel clears the phase deterministically. The phase appears in chat while active, while detailed tool/terminal events remain in the right panes without duplicated model text.

## Failure handling and boundaries

- Missing tools produce localized actionable errors with detected path/version data.
- Explicit routes never silently fall back to another OS or compiler.
- WSL/reboot/install progress survives restart and is re-detected rather than assumed.
- Android extension installation and route integration are validated locally. SDK, Gradle build, emulator, and device claims require a real Android project/toolchain.
- iOS is validated as configuration, connection, and remote command routing only until a macOS/Xcode host is supplied.
- No broad permission tightening, GitHub sign-in requirement, new container orchestration layer, or duplicate browser/runtime core is introduced.

## Verification contract

Tests are added before implementation for route selection, unavailable-target errors, MSVC initialization, browser action dispatch, icon packaging, phase transitions, and menu migration. Existing focused tests remain green.

Machine 3 verification covers:

- installed executable/process, working directory, configuration source, user-data path, write permissions, and logs;
- PowerShell script execution and OctoCode/`code` CLI version, help, open, extension list/install/remove, and isolated-user-data behavior;
- WSL shell plus GCC compile/run; Docker Engine `hello-world`, build/run/restart/remove; Java compile/run; Go test/build/run; .NET create/build/test/run; MSBuild and MSVC/Clang compile/run; FFmpeg generation/transcode; Pandoc document conversion; Android SDK/Gradle build;
- browser open/navigation/snapshot/click/fill/assert/screenshot/console/network using the integrated pane;
- real mouse/keyboard checks of menus, resource entries, environment settings, waiting/thinking/executing states, close/reopen, hotkey, restart, and cold start;
- expected-clean application logs after warnings, fallbacks, and errors are investigated.

Windows tests are real. WSL and Docker are real only after successful feature enablement and engine execution. iOS/macOS remains an explicitly reported interface-only result unless a reachable Mac is provided.
