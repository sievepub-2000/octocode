# OctoCode Native Agent Workbench Design

**Date:** 2026-08-22
**Status:** Approved in chat; pending written-spec review

## 1. Objective

Turn OctoCode into a native desktop agent workstation built on the existing VS Code/Electron core without retaining the visible IDE-first layout. The product must present a resizable Codex-style task navigator, central conversation, multimodal artifact area, and live terminal while preserving the mature editor, diff, filesystem, terminal, browser, extension, and cross-platform capabilities already present.

The same release also adds task deletion, a local web-to-Markdown knowledge base with MCP CRUD, three server-enforced permission modes, and an auditable autonomous research harness. Existing SGLang, Qwen3.8-27B, DFlash2, broad command access, optional sign-in, and local model settings remain authoritative.

## 2. Architectural Decision

Use native workbench composition rather than rebuilding the editor and terminal inside one React application.

- The primary side bar hosts task and knowledge management.
- The center editor group hosts the OctoCode conversation webview.
- The upper-right editor group hosts native files/diffs and the OctoCode Artifact Viewer.
- The lower-right editor group hosts a native terminal editor and run status.
- Native VS Code grid sashes provide resizing. Commands and persisted workspace state provide collapse, restore, and first-start defaults.

Rejected alternatives:

- A single all-React workbench would duplicate Monaco, terminal, file lifecycle, browser, and accessibility behavior.
- A new VS Code workbench part would create a much larger upstream merge surface without improving the required workflows.

## 3. Window Structure

### 3.1 Left: Tasks and Management

Default width is 280 px, with a practical range of 220-420 px.

The navigation view contains:

- new task;
- active, recent, archived, and child tasks;
- task search and workspace filtering;
- per-task delete and multi-select delete;
- knowledge sources and crawl status;
- MCP servers, skills, modes, settings, and permission mode.

Deletion requires an explicit confirmation in review mode and a standard destructive-action confirmation in other modes. A deletion transaction removes the task record, messages, checkpoints, and task-owned temporary artifacts. It must not delete knowledge-base documents or user files merely referenced by the conversation. UI removal happens only after server-side success. Restart must not restore a deleted task.

### 3.2 Center: Conversation

The existing ChatView remains the sole authoritative conversation surface. It retains modes, model profile, auto-approval, context attachment, tool messages, checkpoints, and task progress. It opens in the primary editor group instead of creating an empty group to its left. Minimum usable width is 460 px.

### 3.3 Upper Right: Artifact Viewer

The upper-right surface uses native editors when they are already the best renderer and a focused Artifact Viewer for formats the native workbench does not cover.

Artifact routes:

- text, source code, and diffs: native VS Code/Monaco editor;
- raster images and SVG: native image support plus optional canvas overlays;
- PDF: Chromium/PDF viewer;
- audio: native audio playback plus Web Audio API waveform and frequency visualization;
- video: native video playback, duration, track, subtitle, and metadata display;
- 2D interactive content: Canvas/WebGL, without a second general rendering dependency;
- 3D formats such as GLTF/GLB, OBJ, STL, and PLY: Three.js WebGPURenderer with automatic WebGL 2 fallback;
- web pages: the existing Chromium/Simple Browser surface coordinated with browser MCP state;
- run status: current tool, command, elapsed time, exit state, touched files, and diagnostics.

Tabs are Preview, Changes, Browser, and Run. A tab can be pinned, closed, collapsed, or maximized. Resource loading is lazy: Three.js, media decoders, and browser processes load only when their artifact type is opened.

### 3.4 Lower Right: Terminal

Use the native VS Code terminal editor rather than a terminal emulator implemented in the webview. It must preserve shell integration for PowerShell, POSIX shells, and macOS shells, including raw command text, working directory, streaming output, exit code, cancellation, and recovery.

The default right-side vertical split is 60% artifact and 40% terminal. The terminal can collapse to a status strip or maximize within the right column.

### 3.5 Resize and Persistence

All visible boundaries use native workbench sashes. Pane width, height, visibility, selected tab, and pinned artifact persist per workspace. When the window is narrow, the center conversation remains usable; the right column collapses first and the left column second. No input control may be clipped.

## 4. Code Intelligence

Monaco and VS Code remain the editing engines. OctoCode already ships `web-tree-sitter` and language WASM grammars; this existing parser layer is reused for incremental syntax structure, symbols, code chunks, and agent context. No second editor or duplicate parser package is added.

Tree-sitter output supplements, but does not replace, language-server semantic information. Parser failures fall back to the current text/chunk pipeline.

## 5. Local Knowledge Base

### 5.1 Storage

Use an Obsidian-compatible Markdown vault as the durable, human-readable source of truth. Each document contains YAML metadata with source ID, canonical URL, title, retrieval time, content hash, and tags. Assets are stored under a source-owned attachment directory.

Use a local SQLite database for source metadata, crawl jobs, document mapping, and full-text search. The database is rebuildable from the Markdown vault and is not the sole copy of user content. Writes use transactions and atomic file replacement.

### 5.2 Crawl Engine

Use a pinned, verified Crawl4AI worker because it supports dynamic pages, Markdown generation, sessions, and MCP. It runs on demand rather than as a permanently busy browser service. Static retrieval may reuse cache; JavaScript pages start managed Chromium. Deployment runs the project's setup/doctor checks and never installs an unpinned floating package.

The worker is an implementation detail behind one OctoCode knowledge service. The UI and agent do not depend directly on Crawl4AI-specific schemas.

### 5.3 Source Lifecycle

The UI supports:

1. add a URL and optional crawl limits;
2. start the source;
3. show queued, running, completed, stopped, or failed state;
4. convert fetched content to Markdown;
5. canonicalize, deduplicate, save assets, and update search indexes;
6. inspect and edit the source or document;
7. delete a source and its source-owned documents after confirmation.

No background recrawl scheduler is added in this release. A future scheduler can call the same `source_start` operation.

### 5.4 MCP and Local API

Expose the same application service through MCP tools and a loopback-only local HTTP API.

MCP tools:

- `source_add`
- `source_list`
- `source_get`
- `source_update`
- `source_delete`
- `source_start`
- `source_stop`
- `knowledge_search`
- `document_get`
- `document_update`
- `document_delete`

The HTTP API provides equivalent CRUD and job operations for the desktop UI. It binds to loopback, uses an installation-local bearer token stored in encrypted secret storage, validates URLs, blocks unintended local-network targets by default during web ingestion, limits redirects and payload sizes, and records crawl provenance.

## 6. Permission Modes

Permission checks are enforced in the extension host/tool dispatcher, not only hidden or disabled in the UI.

### 6.1 Review

- Read and analyze without confirmation.
- File mutation, command execution, browser mutation, crawling, software installation, and destructive actions require confirmation.

### 6.2 Directory

- Read, write, and execute within explicitly selected roots.
- Browser access, research, crawling, and knowledge operations are allowed.
- Mutations outside allowed roots require confirmation.
- Path checks resolve symlinks and canonical paths before authorization.

### 6.3 Full

- Default mode, preserving the user's existing broad-command requirement.
- May install tools, run commands, modify files, browse, crawl, delegate, and iterate without per-operation confirmation.
- Authentication enforcement and the permission-control implementation are protected control-plane settings and cannot be silently rewritten by an agent task.

Every mode records tool, path, command, URL, decision, outcome, and originating task in a local audit log. The interface provides stop/cancel controls in all modes; these are execution controls, not permission restrictions.

## 7. Autonomous Research Harness

Do not embed Karpathy's training-specific `autoresearch` repository as the general desktop harness. Implement its useful experimental loop using existing OctoCode tasks, subtasks, checkpoints, terminal tools, and evaluators.

Loop:

1. state a hypothesis and measurable success criterion;
2. create the smallest experiment;
3. execute it in the selected permission mode;
4. collect tests, metrics, diffs, logs, and resource use;
5. keep the change when the metric improves, otherwise restore the checkpoint;
6. record the decision and begin the next bounded iteration;
7. stop on success, limit, cancellation, repeated failure, or exhausted options.

Configuration includes objective, evaluator command or assertion, maximum iterations, wall-clock limit, and optional resource bounds. Full mode makes the harness available without per-step approval, but it runs only after a user starts an autonomous research task. “Self evolution” means auditable improvement of the selected project, tools, workflows, or knowledge. It does not mean silently mutating the permission system, authentication control, or opaque application binaries.

## 8. Existing Defect Remediation

The release must also:

- stop `openInNewTab` from creating an empty editor group;
- remove unused Open in Agents, Copilot status, and nonfunctional AgentHost protocol initialization;
- replace unconditional global model-cache refresh with provider-scoped refresh so the local OpenAI/SGLang profile does not contact OpenRouter;
- represent a missing workspace as unavailable rather than `Index error`;
- replace visible VS Code, Roo Code, and `.roo/tools` product copy with OctoCode terminology while retaining a silent one-way legacy data migration;
- label credential storage generically as encrypted credential storage;
- trace and replace the controllable `url.parse()` caller;
- remove unsupported webview permission declarations while retaining effective sandbox isolation;
- keep optional Sign In visible and keep `requireAuthentication=false` in the default build;
- keep telemetry disabled and avoid empty-key telemetry initialization.

## 9. Data Flow and Failure Handling

Agent events are the common event source. Conversation messages remain in ChatView; artifact-worthy events route to native editors or the Artifact Viewer; terminal commands route to the native terminal and publish summarized run state. Task and knowledge updates use durable service transactions before UI acknowledgement.

Failures are explicit and recoverable:

- renderer failure shows metadata, raw-file open, and retry;
- WebGPU failure falls back to WebGL 2;
- parser failure falls back to text;
- crawl failure preserves the previous good document and job log;
- interrupted source updates do not replace the previous document;
- terminal cancellation reports a cancelled result rather than leaving a prompt in an ambiguous running state;
- permission denial identifies the mode and operation that denied it;
- autonomous experiments restore their checkpoint after evaluator failure when restoration is safe.

## 10. Testing and Acceptance

Automated tests follow red-green-refactor and cover:

- startup editor layout and no empty group;
- sidebar task rendering, single deletion, batch deletion, associated cleanup, and restart persistence;
- pane routing, collapse state, and persisted dimensions;
- artifact MIME/extension routing;
- audio waveform downsampling;
- Three.js lazy load and WebGL fallback;
- Tree-sitter reuse and parser fallback;
- provider-scoped model refresh with no OpenRouter call for the local profile;
- no-workspace index state;
- permission decisions at the server/tool-dispatch boundary, including canonical path escapes;
- source and document CRUD, crawl job transitions, deduplication, atomic updates, deletion, and full-text search;
- autonomous experiment keep, rollback, stop, limit, and resume behavior;
- visible legacy-copy scan.

Fresh builds must pass for the extension webview, extension host, CLI, and desktop shell. Runtime acceptance on machine 3 includes:

- cold launch and restart persistence;
- drag and collapse of every pane;
- real Qwen3.8/SGLang conversation;
- PowerShell command streaming and cancellation;
- file edit and diff preview;
- image, audio waveform, video, 3D, PDF, and embedded-browser display;
- browser MCP and knowledge ingestion of static and JavaScript pages;
- full source/document CRUD with cleanup in `finally`;
- all three permission modes, including denied and allowed cases;
- autonomous multi-iteration measurement and rollback;
- no unintended OpenRouter traffic;
- console, extension-host, and service logs checked for errors, warnings, fallbacks, duplicate data roots, and competing live instances.

Windows is the required live platform for this deployment. Windows, Linux, and macOS path/command/build semantics must be checked. No unexecuted platform or Docker run may be reported as a live-platform pass.

## 11. Scope Boundaries

- No cloud synchronization or hosted account service is added.
- No full Notion clone is deployed.
- No second general code editor is added.
- No always-on recrawl scheduler is added.
- No vector embedding service is required for the first release; full-text retrieval remains functional without another model. A future semantic index may be added behind the same knowledge-search interface.
- Existing user conversations, model settings, secrets, and knowledge data must be preserved except when explicitly deleted through their lifecycle operations.
