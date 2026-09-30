# OctoCode Rust Core v2 Design

## Objective

Rebuild OctoCode as a local-first desktop agent whose product shell retains the existing VS Code editing, language-service, terminal, browser and multimodal capabilities while agent orchestration, persistence, memory, model compatibility and long-running task control move to Rust wherever a mature native subsystem is not already the better choice.

This is a fresh installation. No legacy conversation or database migration is required.

## Product architecture

OctoCode has four deep modules:

1. **Desktop Workbench** — the existing VS Code/Electron shell and React UI. It owns presentation only: chat, task navigation, settings, browser, editor, terminal, Office/PDF/media/2D/3D renderers and the live execution inspector.
2. **Agent Runtime** — the Apache-2.0 Grok Build Rust runtime, invoked through ACP over stdio. It owns goals, planning, workflows, tools, MCP, subagents, compaction, verification, recovery and cancellation.
3. **Octo Store** — a Rust SQLite module built from Grok Build's bundled-rusqlite, xai-sqlite-journal and sqlite-vec patterns. It is the authoritative structured-data source.
4. **Model Gateway** — Grok Build's mature Chat Completions, Responses and Anthropic Messages backends. LiteLLM is an optional lazy sidecar for vendor protocols not covered directly. Local SGLang uses the direct OpenAI-compatible backend.

The Desktop Workbench talks to the Rust host with newline-delimited JSON-RPC over stdio. The host proxies ACP to the Agent Runtime, persists normalized events and sends the same normalized event stream to the UI. No loopback web server is introduced.

## Rust-first rule

New orchestration, database, retention, vector search, ACP supervision, event normalization, model capability probing, process control and recovery code is Rust. TypeScript remains only at the VS Code extension seam and React renderer. Python remains only where an external MCP implementation has no equivalent and is removed when the Rust host can provide the same function with less runtime cost.

The project does not rewrite VS Code, Chromium/WebView, Three.js, PDF.js or mature Office/media parsers.

## Single database

The authoritative database is `<user-data>/OctoCode/octocode.db`.

SQLite is compiled into the Rust host with FTS5 and sqlite-vec. Local disks use WAL. Network filesystems use the safe journal selection inherited from `xai-sqlite-journal`. Foreign keys, busy timeout and transactional schema migrations are mandatory.

Tables:

- `sessions`: title, workspace, model, lifecycle, timestamps and user-editable metadata.
- `messages`: ordered user, assistant and system content.
- `events`: append-only normalized runtime events and sequence numbers.
- `tool_runs`: tool name, validated input, lifecycle, output summary, exit status and timing.
- `artifacts`: MIME type, content-addressed file path, hash, source event and display metadata.
- `logs`: level, subsystem, structured fields, timestamp and optional session/tool relation.
- `workflow_runs`: goal, phase, verifier gaps, budget, heartbeat, lease and recovery state.
- `settings`: typed JSON values including log retention and language-pack manifests.
- `knowledge_documents` and `knowledge_chunks`: canonical knowledge content and provenance.
- `memory_items` and `memory_chunks`: durable learned facts, evidence, confidence and validity.
- FTS5 indexes for messages, logs, knowledge and memory.
- sqlite-vec `vec0` indexes for knowledge and memory embeddings.

Secrets are stored in the operating-system credential store. Large artifacts remain in a content-addressed directory; the database stores their identity, metadata and provenance. These two exceptions prevent plaintext-secret exposure and database bloat.

Logs default to 30 days. Tool stdout/stderr detail follows the same default while the durable execution summary remains with the session. Retention is configurable from 1 to 3650 days or unlimited. Cleanup runs on startup and every 24 hours, in bounded batches, followed by incremental vacuum when useful. Conversations, knowledge and memories are never age-deleted automatically.

## Vector memory

The database always contains vector-capable sqlite-vec tables. The default local embedder is `fastembed-rs` with `intfloat/multilingual-e5-small`, 384 dimensions, loaded lazily on first indexing or semantic search. The model cache is product-managed and removable in Settings. An OpenAI-compatible `/embeddings` endpoint can replace the local embedder.

If embeddings fail, retrieval falls back to FTS5 and the UI exposes the degraded state. Hybrid retrieval merges FTS and vector candidates, applies diversity, and retains source/evidence links.

Memory promotion occurs only after a task checkpoint or final verifier result. Candidate memories are normalized, checked for conflicts, vector-deduplicated and stored with provenance. Failed hypotheses are retained as scoped lessons, not promoted as facts. Memory changes are visible and editable in the UI.

## Model and tool compatibility

The internal tool interface is one JSON-Schema-based representation compatible with MCP. Provider-specific request and response shapes never escape the Model Gateway.

Protocol order is selected by a cached, non-destructive capability probe keyed by endpoint, model and server version:

1. OpenAI Responses function tools.
2. OpenAI Chat Completions `tool_calls`.
3. Anthropic Messages tools.
4. XML tool blocks for models without reliable native tools.

SGLang uses the direct OpenAI-compatible path. OpenAI and Anthropic use their native Grok backends. Gemini, Vertex, Bedrock, Azure and other vendor protocols use the mature LiteLLM gateway only when direct compatibility is unavailable. A protocol does not silently change mid-task except for one deterministic compatibility retry before the first tool execution.

## Long-running autonomy

Grok Build goal and workflow machinery replaces the existing score-only autoresearch loop.

Each run persists:

- objective and measurable acceptance criteria;
- plan and current phase;
- tool and subagent budget;
- current worker lease and heartbeat;
- verifier evidence and unmet gaps;
- no-progress fingerprint and retry count;
- checkpoints, artifacts and recovery cursor.

The loop is Plan → Execute → Verify → Reflect. Verification uses real command exits, files, rendered artifacts, service health and model responses. A failed verifier produces explicit gaps. The strategist may restructure the plan. Repeated identical gaps trigger a no-progress pause instead of a doom loop. Infrastructure failures back off and resume from the last durable checkpoint. Completion requires verifier acceptance, not the worker's claim.

Self-improvement means verified memory, strategy and code changes. The runtime may modify its source only through the same checkpoint, build, test and rollback path as any coding task; it never replaces a running binary without a verified installer.

## Live execution inspector

The Rust host emits monotonically sequenced events for session state, plan changes, model streaming, tool start/progress/end, terminal output, file reads/edits/diffs, browser navigation, artifacts, verifier results, memory writes, warnings and failures.

The right workbench column has:

- an upper multimodal/status region, initially 75% of the right column;
- a lower terminal region, initially 25%;
- draggable splitters, independent collapse and persisted ratios.

The upper region switches without losing state among Timeline, File/Diff, Browser, Image, PDF/Office, Audio, Video, 2D canvas and Three.js 3D views. Audio displays a waveform. Office files render through mature parsers or a safe converted preview. Unsupported formats show metadata and an Open action rather than a blank panel.

## UI data management

Tasks, messages, logs, tool runs, workflows, knowledge and memory expose create/read/update/delete or archive operations through typed Rust host methods. Every mutation is enforced in the host and read back after commit. UI optimistic state is not authoritative.

The OCTOCODE product mark remains fixed at the window's classic top-left location. The action menu begins at the left of the following row and overflows into an ellipsis. All 18 currently shipped languages remain explicitly selectable; external JSON language packs are stored as validated manifests in `settings`.

## Packaging and verification

The Windows installer is a signed-capable EXE that installs under `D:\Program Files\OctoCode`, bundles the Rust host, Grok runtime and desktop shell, registers uninstall metadata and creates the shortcut. The old installation and old user data are removed only after the new package passes clean-install validation.

Real Windows verification covers every module and menu lifecycle, cold restart, retention, recovery, permissions, SGLang, all three native tool formats, XML fallback and the requested weather/news/PPT/DOCX/system-report/game/image tasks. Linux and macOS build syntax and path semantics are checked statically unless real hosts are available; they are never reported as executed tests without those hosts.

