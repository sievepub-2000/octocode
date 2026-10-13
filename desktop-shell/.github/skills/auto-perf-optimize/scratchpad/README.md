# Scratchpad — one-off scenario runners

This folder is gitignored. Write investigation-specific runners here freely.

## Organization

Put each investigation in a **dated subfolder** named `YYYY-MM-DD-short-description/`:

```
scratchpad/
  2026-04-09-chat-scroll-leak/
    scenario.mts
    findings.md
  2026-04-12-editor-tab-switching/
    scenario.mts
    findings.md
```

Each subfolder should contain:

- **Scripts** — scenario runners, analysis scripts, etc.
- **`findings.md`** — a summary of the investigation: all ideas considered, whether each led to a change or was rejected (and why), and before/after measurements so the user can review decisions and follow up.

Scenario runners you create here can import utilities from the checked-in
scripts or copy patterns from them. When a runner proves generally useful,
promote it to the parent `scripts/` folder.

## Quick start

```bash
# From the repository root, write a runner in a new dated subfolder
mkdir -p .github/skills/auto-perf-optimize/scratchpad/YYYY-MM-DD-topic
cat > .github/skills/auto-perf-optimize/scratchpad/YYYY-MM-DD-topic/my-scenario.mts << 'EOF'
import { chromium } from 'playwright-core';
// ... your scenario
EOF

# Run it
node .github/skills/auto-perf-optimize/scratchpad/YYYY-MM-DD-topic/my-scenario.mts
```

## Checked-in scripts (in `scripts/`)

These are reusable, generic runners. Use them directly or as templates:

- **`chat-memory-smoke.mts`** — Multi-turn chat smoke runner. Sends prompts,
  waits for responses, samples heap, takes optional snapshots. Supports
  `--message`, `--iterations`, `--skip-send`, `--keep-open`, `--reuse`, etc.

- **`chat-session-switch-smoke.mts`** — Creates multiple chat sessions with
  different content, then repeatedly switches between them via the sessions
  sidebar. Measures per-switch memory growth.

- **`userDataProfile.mts`** — Utility for managing user-data profiles in
  smoke test runs.

## Tips

- Prefer `--user-data-dir .build/auto-perf-optimize/user-data` (the
  persistent profile with Copilot auth). Use `--temporary-user-data` only
  when a clean profile is part of the scenario, as described in the parent skill.
- Use `--skip-prelaunch` to avoid re-downloading Electron on every run.
- If you need to clean up an orphaned test instance, stop only the specific
  Code - OSS process (e.g. by killing the PID that was logged at launch, or
  `lsof -ti :<port> | xargs kill`). Avoid `pkill -f 'Electron'` — it can
  kill unrelated Electron apps.
- For heap snapshot analysis, use the `heap-snapshot-analysis` skill's
  scratchpad and helpers.
