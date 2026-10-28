# Google Harness2 integration

OctoCode runs Google's actual recursive scheduling, evidence construction,
proposal validation, composition and budget accounting with its existing local
task API and saved model. The Rust harness remains the executor. No extra model
provider, external agent CLI, benchmark dataset or Python package install is needed.

Start the installed OctoCode API first. Then use the installed Harness2 launcher,
or invoke its Python entrypoint directly:

```powershell
& 'E:\Program Files\octocode\environments\python\python.exe' `
  'E:\Program Files\octocode\environments\scripts\octocode_harness2.py' `
  --cwd 'C:\path\to\project' --mode seq --depth 1 `
  'Review this project and explain the three most important correctness risks'
```

`seq` composes improvements round by round; `agg` composes parallel candidates.
Depth is bounded to 1–4. Each depth costs four solver sessions plus three improvement
sessions, with upstream transport/invalid-proposal retry behavior. These are native
task sessions, not a count of model HTTP requests: tool turns, the existing
reviewer and retries may each make additional model calls. The existing
API's saved model is inherited; keys are never passed on the command line or
written to the Harness2 result. `OCTOCODE_API_TOKEN` takes priority; otherwise the
installed client's daemon token is read from its existing protected user-data
location (installation root from `OCTOCODE_ROOT` or bundled Python location).
The adapter accepts loopback HTTP API URLs only.

On Windows, the API reads the currently selected OpenAI-compatible desktop
profile from the existing encrypted VS Code credential store using the current
user's DPAPI key. Decryption stays in memory. It does not reuse task-local proxy
addresses from old session configs. Other desktop provider types and other
platforms require an explicit API model/endpoint; API keys can use the existing
`OCTOCODE_MODEL_API_KEY` environment variable.
The CLI accepts `--model <id> --base-url <endpoint>` together for that case.

Saved provider controls, including thinking style/tier, output budget and API
format, are preserved. Manual context settings take precedence when automatic
context is disabled. Otherwise the selected `/models` entry supplies the effective
window, using the desktop client's field precedence. Discovery has a five-second
I/O budget, a 4 MiB response limit, no redirects and a 60-second profile-identity
cache held only in memory. Unknown metadata does not silently reduce the window:
configure a manual window or pass `--context-window <tokens>` explicitly.

Every native run starts a fresh conversation and uses `directory` permissions.
In the current native runtime this permits read-only tools. This entrypoint is
therefore useful for project investigation, review, analysis and answer tasks;
it does not grant autonomous coding writes. Improvement sessions can change only
task-local `AGENTS.md` text through validated JSON. Scripts, hooks, skills, model
settings and permission changes are rejected. Original project guidance is not
overwritten. No task libraries or evidence are shared between projects or runs.
An optional official `<notes>` block is preserved separately from the guidance;
other leading/trailing commentary is rejected and receives one upstream retry.
The API preserves the selected source project while executing in the native
conversation directory; cross-project session continuation is rejected. The
current native read-only permission limits tool types, and does not provide an
operating-system sandbox restricting all reads to a project directory.

Pass `--adopt` to retain a successful final guidance prompt in this project's
`.octocode/harness2/adopted.json`. Later runs in that same project use it as their
base harness. Adoption is explicit and atomic; unsuccessful runs never replace
it. Other projects have separate state. This task-level text integration does
not implement the upstream POSIX library/adoption subsystem or all eight
executable harness components.

Audit files are stored under `<project>\.octocode\harness2\run-*`: the final
`result.json`, individual `runs/*/answer.md`, native run IDs and summaries,
solver `trajectory.json` with actual tool calls and observations, proposer
evidence and each candidate harness. Internal thought events are excluded.
These files contain task text and
answers and should be treated as project data. A fallback or unsuccessful solver
sets `ok=false` and the CLI exits nonzero. A rollout timeout cancels its native run.

The vendored source and exact upstream pin are documented in
`desktop-shell/build/environment-scripts/harness2_vendor/PROVENANCE.md`.
Upstream declares Python 3.12–3.13/POSIX. The selected dependency-free core and
adapter are additionally tested on OctoCode's Windows Python 3.14.7; that does not
change upstream's declared support.

The original complete upstream workflow suite was also tried on Windows and
fails because its library/scheduling paths require POSIX `fcntl`; those paths
are excluded from this integration rather than bypassing their locks.

Development check:

```powershell
Set-Location desktop-shell/build/environment-scripts
python -m unittest test_octocode_harness2 -v
```

The focused tests execute both real upstream recursion modes using a deterministic
model callback. This proves scheduling and adapter contracts, not real model
quality or live installation acceptance; those need an installed-daemon run.
