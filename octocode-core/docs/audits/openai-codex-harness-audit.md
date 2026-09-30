# OpenAI Codex harness integration audit

Date: 2026-08-23

## Revisions and scope

- OpenAI Codex: `openai/codex@83d1fe0e67b1323f71febc2925817732b449f1d9`.
- Grok Build: `xai-org/grok-build@19d42e35c07a9c9244f03f6df0c4c353f970d4f9`.
- OctoCode: local product source under `octocode/` (no Git metadata).
- Inventory covered every tracked source file. Deep review covered the agent loop, provider routing, tool protocol, Codex-derived file tools, shell execution, permissions/sandbox, MCP, skills/plugins, subagents, compaction, persistence/traces, cancellation, headless streaming and OctoCode's TypeScript-to-Rust launch seam.

## Existing integration discovered

Grok Build is already the unified Rust harness. It contains attributed in-tree source ports from OpenAI Codex under `xai-grok-tools/src/implementations/codex/`: `apply_patch`, `read_file`, `list_dir`, and `grep_files`. The root and crate notices identify the upstream paths and preserve the Apache-2.0 attribution. Grok then integrates those tools into one permission manager, one session loop, one MCP/plugin system, one compaction path and one streaming protocol.

Importing `codex-core`, starting a second Codex process, or adding a second rollout database would therefore duplicate functionality and violate the single-harness requirement. OctoCode retains exactly one executable harness (`octocode-harness.exe`) behind one Rust coordinator (`octocode-host`).

## Module disposition

| Codex capability | Unified OctoCode implementation | Decision |
| --- | --- | --- |
| Apply patch/read/list/grep | Grok's existing attributed Codex ports | Reuse; no second tool registry |
| Agent loop and tool orchestration | Grok session/agent/tool runtime | Reuse; Grok has the provider and Qwen-compatible loop |
| Shell and long-running process control | Grok shell/workspace runtime | Reuse; do not add Codex unified-exec beside it |
| MCP, plugins, skills and subagents | Grok native systems plus OctoCode Workbench MCP | Reuse; one marketplace and one lifecycle |
| Context compaction | Grok native automatic compaction | Explicitly pin the documented 85% threshold |
| Rollout trace | OctoCode SQLite ordered events/logs plus Grok session events | Reuse; a second JSONL trace would create competing state |
| Provider protocol adaptation | `octocode-host::provider` to a single generated Grok model profile | Reuse; explicitly pin `agent_type = "grok-build"` |
| Permission profiles | OctoCode UI → Rust `PermissionProfile` → Grok native mode | Fixed: review=`default`, directory=`auto`, full=`bypassPermissions` |
| Codex granular approvals | Grok permission rules/auto classifier | Do not port experimental Codex protocol into a different permission engine |
| Codex environment execution | Grok workspace/sandbox | Do not port a second executor |
| Codex Responses metadata additions | Grok/OpenAI-compatible provider and streaming event normalization | Protocol concept retained; Codex wire structs are not compatible drop-ins |

## Post-sync Codex changes reviewed

Security-relevant Codex changes after the Grok snapshot include preventing `apply_patch` from widening permissions, no-follow filesystem access for unsandboxed patching, granular sandbox approvals, environment network policy enforcement, and unified-exec shell snapshots. These changes harden Codex's own orchestrator and executor. Grok uses a different `AsyncFileSystem`, permission manager, shell runtime and OS sandbox, so copying those files would bypass Grok's integration points rather than harden them.

The applicable product-level controls are already enforced at Grok's shared authorization seam: tool metadata classifies `apply_patch` as a write operation, deny/ask/allow rules precede prompt policy, and the selected native permission mode controls execution. The OctoCode defect was upstream of this seam: every run was launched with `--yolo --permission-mode bypassPermissions`, regardless of the UI setting. That defect is fixed in the single launch path and regression-tested.

Grok's optional OS sandbox is not forced by OctoCode. Its own documentation only provides kernel enforcement on Linux/macOS, warns and continues when unavailable, and fixes a sandbox profile for the life of a resumed session. Forcing it in the cross-platform desktop would add Windows warnings and make an existing conversation fail after a profile change. The three product modes therefore use Grok's cross-platform permission engine; `full` remains the default as requested.

## Resulting invariants

1. Exactly one harness process and one selected `agent_type`.
2. Exactly one provider route and model profile per run.
3. Exactly one permission decision path; no hard-coded YOLO outside the `full` profile.
4. Exactly one persistent OctoCode database for product records and ordered runtime evidence.
5. Grok owns long-horizon execution, compaction, subagents, plugins, MCP and shell semantics; VS Code remains the desktop/workbench surface.
6. Provider credentials stay in the child-process environment and are never written to generated config.

## Verification gates

- `cargo test -p octocode-host` covers permission mapping, generated configuration, provider routing, RPC, ordered events and database lifecycles.
- `cargo test -p codex-apply-patch` validates the current upstream patch engine.
- `cargo test -p xai-grok-tools codex` validates the integrated Codex-derived Grok tools.
- A release rebuild of Grok and OctoCode is required before packaging.
- A clean machine-3 install and real machine-2 Qwen task remain required before release acceptance.
