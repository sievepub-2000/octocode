# Octocode Project Strategy

## Scope

This file records project-level execution policy for Octocode.

## GitHub Update Strategy

### Verified history

1. The last commit that is confirmed to have reached GitHub is `45549b6` with message `Advance canvas UI and desktop packaging`.
2. The current local-only commit is `ec94438` and must not be described as synced until `origin/master` matches `HEAD`.

### Correct update method

Use the standard non-interactive git flow inside the Octocode repository:

1. Run focused validation first.
2. Check `git status --short` and review the intended file set.
3. Stage explicitly with `git add <files...>` or `git add .` only when the whole worktree is intended.
4. Commit with `git commit -m "..."`.
5. Push with `git push origin master`.
6. Verify sync with both:
   - `git rev-parse HEAD`
   - `git rev-parse origin/master`
7. Only describe GitHub as updated when those two revisions are equal.

### Failure handling

1. If `git push` fails because of network, DNS, TLS, or remote connectivity, report the repository as `local committed, remote not synced`.
2. Do not claim success based only on a local commit.
3. Do not switch to alternate GitHub update tooling unless the standard flow is unavailable for a repository-specific reason.
4. Do not rely on Git-integrated helper tools when they fail to actually stage or push changes; fall back to explicit git commands.

## Browser Verification Strategy

### Preferred path

1. If Lightpanda is installed and callable, it can be used for browser-driven verification.
2. If Lightpanda is not installed or not exposed in the current environment, use the real running WebUI with the available browser and HTTP verification tools.

### Current environment fact

At the moment `lightpanda` is not available as a callable command in this workspace environment, so browser verification must use the running WebUI plus accessible browser tooling instead of claiming a Lightpanda run.

## Delivery Rules

1. Prefer phased, verifiable refactor steps over broad rewrite claims.
2. Do not claim Claude Code / Claw Code full parity without executable validation for the touched slice.
3. Keep Windows as an actively validated platform during implementation.

## Branch And Commit Rules

1. Keep `master` releasable; do not leave known compile failures in the branch.
2. Prefer small refactor commits that stabilize one runtime boundary at a time.
3. When a refactor changes `octocode-core`, `octocode-api`, `octocode-runtime`, or `octocode-cli`, validate the touched path before moving to the next boundary.
4. Do not mix UI-shell experiments, runtime boundary changes, and release packaging fixes into one commit unless they are required for the same executable slice.

## Runtime Layering Rules

1. `octocode-core` owns stable domain types and contracts only: provider capability surface, provider factory contract, permission policy contract, tool catalog contract, session and workspace types.
2. `octocode-api` owns provider wire behavior only: base URL, auth, protocol payloads, model listing, circuit-aware adapter composition.
3. `octocode-runtime` owns session persistence, permission enforcement, provider routing orchestration, tool registry usage, config paths, and platform shell execution.
4. `octocode-cli` owns parsing, renderers, transport boot, and shell entrypoints. It must consume runtime surfaces instead of re-implementing business rules.
5. Canvas UI, desktop shell, VS Code, Cline, and Cursor layers must consume runtime events and snapshots rather than writing business logic directly into the shell.

## Windows-First Validation Rules

1. During implementation, continuously validate PowerShell invocation, path normalization, config-home resolution, and terminal compatibility on Windows.
2. Prefer PowerShell 7 when available, then Windows PowerShell 5.1, and only fall back to `cmd` when neither shell is callable.
3. Any change that touches workspace tools, shell execution, config paths, or session persistence must be followed by a Windows-focused smoke test before claiming completion.
4. Do not defer process tree, path, or terminal compatibility checks to a final hardening phase.

## Validation And Regression Gates

1. Runtime boundary changes:
   - `cargo check`
   - at least one focused CLI smoke command
   - real WebUI smoke verification when backend or runtime snapshot surfaces changed
2. Provider routing changes:
   - verify provider list rendering
   - verify status/health output
   - verify config load/save still resolves provider id, base URL, and model
3. Session or permission changes:
   - verify session create/resume/export
   - verify read-only versus workspace-write denial behavior
4. Windows platform changes:
   - verify `doctor`
   - verify config path materialization
   - verify a shell-command tool round-trip

## Release Rules

1. Before a release tag or packaged desktop artifact, re-run compile validation and WebUI smoke validation from a clean terminal.
2. Do not describe a build as release-ready unless config initialization, provider listing, session resume, and UI state export all succeed on the target platform.
3. If GitHub sync is blocked, report the release state as local-only and do not treat the GitHub repository as current.