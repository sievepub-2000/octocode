# Harness2 integration evidence, 2026-10-25

Official source is Google Research `harness2`, commit
`1cfe254e8d25b15f37048c3730134686abe60335`, Apache-2.0. Ten selected
Python source files, LICENSE and pyproject.toml match upstream byte for byte.
The original pyproject is retained only to anchor upstream ROOT resolution;
the vendored subset is not a pip-installable distribution. Upstream declares
Python 3.12–3.13/POSIX; the selected task-recursion core is tested separately
on the installed Windows Python 3.14.7.

Implementation uses actual upstream sequential/aggregate recursion and evidence
logic. Solver and improver sessions go through OctoCode's native task API and
currently selected encrypted desktop OpenAI-compatible profile. Native directory
permissions remain read-only. Editable output is restricted to AGENTS.md text;
scripts, hooks, executable components and permission/model changes are rejected.
Adoption is explicit, atomic and project-local. The original Rust harness remains
the executor. The complete upstream POSIX library/scheduling suite was attempted
and fails on Windows because of `fcntl`; those paths are excluded.

Evidence is under `E:\Program Files\octocode\test\harness2-acceptance-20261025`:

- `live-result.json` and its upstream `result.json`: the fixed staged identity
  executed four real solver runs; all returned `HARNESS2-OCTOCODE-742` after real
  reads. Ledger R=4/P=3; four improvement attempts were made. The old JSON-only
  parser rejected Compose responses carrying an official notes block, so its
  strict result is **failed**, `fell_back=["c1"]`, with no adoption. This is not
  counted as a successful final-head workflow.
- `compose-response-replay-result.json`: both real completed Compose responses
  were replayed against the corrected parser. Each JSON object was validated and
  its single official notes block preserved. This is recorded-response replay,
  not another live model execution. Other trailing text/multiple notes are rejected.
- `trajectory-api-result.json`: the latest client read 41 real SSE events from a
  completed native solver, including `read_file`. Focused tests prove conversion
  to ACTION/OBSERVATION/ERROR evidence, excluding internal thought events.
- `resume-boundary/result.json`: the latest API and installed native host reject
  cross-project continuation before `harness.continue`; original message/event
  serialized bytes remain identical, with zero model calls.
- `acceptance-provenance.json`: exact source/staged hashes and separately verified
  differences. Runtime adapter after the protocol fix has SHA-256
  `f3ee5f2bbcb4fde356947abed5927f554a5f80eb23d7b36e3ba0e06d445e7f8c`.
- `secret-boundary-result.json`: current real provider key was compared in memory
  against 887 acceptance/daemon/session files, including SQLite/WAL, configs,
  logs and run summaries: zero matches, zero unreadable files. No key values are
  in this report. Configs use the existing environment-key reference.

The selected profile database is protected for Administrators/SYSTEM/FPP and
remains encrypted. The fixture daemon database inherits Users read/execute,
SYSTEM/Administrators/FPP full control, owned by FPP; project task transcripts
therefore follow project filesystem ACLs. No existing ACL was changed.
Read-only tool selection is not an operating-system sandbox confining every read
to the project root.

The final frozen-head suite ran 45 tests: 44 passed, one platform-specific test
was skipped. The focused suites cover actual upstream seq/agg scheduling, a depth-two budget
check, invalid proposals/retries, native permission forwarding, cancellation,
project-local adoption and cross-project isolation, encrypted-profile failures,
fresh-process dotenv isolation and HTTP lifecycle/cold restart. One existing
parent-crash shutdown test once exceeded 15 seconds; its isolated and complete
suite reruns passed. The final corrected installed entrypoint still requires a
new complete native model run before claiming final-head end-to-end acceptance.

A second fixture, `E:\Program Files\octocode\test\harness2-final-20261025`,
was started with the complete corrected API/helper/SSE/parser and upstream ROOT
marker, plus freshly built host/harness executables copied into its own E-drive
`bin` directory. `candidate-hashes.json` pins those exact execution bytes.
While that fixed identity ran, one isolated fence-only parser correction was
made: fenced responses must end at the closing fence and every character inside
must pass the existing strict JSON/optional-notes parser. The normal raw-JSON
path was unchanged. Its final adapter SHA-256 is
`23cb545f45cdb500f7bd04a0abf775d8a21645d05f9aa1bf1f02a3b8cf1c887f`.
Valid fenced JSON/notes and malformed/trailing fence cases have focused coverage;
this narrow delta is not presented as execution of the same adapter hash as the
running candidate.
The suite after this isolated fence correction ran 46 tests: 45 passed and one
platform-specific test was skipped.

The second full native candidate also ended **failed**, retained in its
`acceptance-result.json`: nine native sessions, R=4/P=3, five improvement attempts
(INV=2, DOM=1, Compose=2), `fell_back=["c1"]`, and no adoption file. All four solver
answers were exact and each performed a real `read_file`; Compose responses still
included unparseable leading commentary. This fixed candidate used a 131072-token
window and the earlier incomplete provider-control mapping. It is not evidence
that the final 1M-capable source completed the whole workflow.

Subsequent source corrections preserve the complete selected provider dictionary
only in RAM. Actual selected settings were auto-context unset, custom catalog
window 262144, high thinking enabled with template style, and no positive custom
output budget. Real `/models` metadata reports `max_model_len=1048576`. The API now
uses explicit manual context when selected, otherwise discovered server metadata;
it refuses an unknown window instead of silently lowering it. Both default and
explicit-endpoint paths preserve discovered capacity. Metadata requests have a
five-second I/O budget, 4 MiB bound, forbidden redirects and a 60-second in-memory
cache keyed by provider identity. The proposer response instructions now explicitly
permit the official notes block, forbid preceding prose, and translate the old
filesystem retry instruction into a JSON-protocol retry.

Separate capability evidence in the second fixture:

- `context-fidelity/result.json`: a real default-model task answered correctly;
  selected model, native route and actual harness config all use 1048576 tokens,
  with high/template thinking preserved and max completion 32768. No key in config.
- `context-resolution/result.json`: latest API default and explicit-endpoint paths
  both resolve 1048576 through the actual fresh native host; native thinking is
  enabled. This check made zero inference requests.
- `secret-boundary-result.json`: an offline RAM-key comparison over 710 files
  found zero plaintext matches and zero unreadable files, with zero network requests.
- `offline-tests.log`: latest suite ran 51 tests, 50 passed and one skipped.

Newest source SHA-256 values:

```text
octocode_harness2.py 8524957aad8ea363adbfc95fd6f0bb26116f374cae7ea5c884a7e6bd045976c4
octocode_api.py 80e30be4b102b6d151fdf75b37a29200d4fc3e860d3a38f46f454b7b9bf58d4b
octocode_credentials.py 6e8e17c95c53e5f96daba85c2b93521b73144614bb90ec314d9e1444e2413703
```

The maintenance window ended before the final acceptance below. The earlier
failed rounds remain failures; the final result uses a fresh independent fixture.

## Physical-E acceptance before the Rust security refresh

`E:\Program Files\octocode\test\harness2-physical-final-20261025` completed the
latest source round successfully, recorded in `acceptance-result.json`:

- `ok=true`, exit 0, `fell_back=[]`, exact file marker returned, `adopted=true`.
- Seven actual native task sessions: four solver rollouts and three proposer
  sessions. INV, DOM and Compose each completed on their first attempt. These are
  task sessions, not a count of provider HTTP calls.
- Adoption validated in a new Python process; the separate project had no
  adopted guidance. Every native session configuration retained context 1048576;
  saved high/true/template reasoning controls remained unchanged.
- RAM comparisons of the real provider key and private API token against 13,576
  fixture files found zero plaintext matches. Encrypted credentials stayed encrypted.
- The private daemon stopped after the run. No production daemon restart occurred.

The three runtime source hashes above exactly match the tested fixture.
Harness version is `octocode-harness 1.0.16 (038fa928cf0c)`; final executable
SHA-256 values are:

```text
octocode-host.exe f036a82a0f3c2537c14b4ed5fdc8f0f2ec4ca29ee15eb745990f54643909350e
octocode-harness.exe dfd6bc58d86060f6a0dc44015597911376cd1759fd26004bf057e7a154883093
```

Python, native binaries, API state, cloned encrypted profile, project, output and
temporary test files were physically within this E fixture, with no reparse
points. Python executable/prefix/sys.path and FastAPI, cryptography, uvicorn,
pydantic, SQLite and SSL modules resolved inside the fixture. All 13,084 copied
Python files matched the build source by SHA-256; 158 bytecode/cache files were
intentionally excluded. The private root ACL admits only FPP, SYSTEM and
Administrators. Original profile files were copied by raw read-only FileStream;
only the private clone was opened with SQLite, preserving production migration
hash checks. The fixture Python also ran 51 tests: 50 passed, one skipped.

This establishes final candidate integration acceptance. Formal desktop
installation, migration and post-install lifecycle acceptance are recorded
separately by the release workflow.

## Final native security rebuild acceptance

A new independent fixture, never overwriting the preceding evidence, passed:
`E:\Program Files\octocode\test\harness2-physical-security-final-20261025`.
Its `acceptance-result.json` records `ok=true`, exit 0, `fell_back=[]`, the exact
34-character marker and successful adoption. The actual seven native sessions
match R=4 and P=3, with one attempt each for INV, DOM and Compose. These are
proposer-stage attempts; they do not imply that every model tool call succeeded.

The tested native executable SHA-256 values are:

```text
octocode-host.exe 3cad8fcf1c19bd05302c11ab1387d7cb63fc2c12e8b79053ab3b35ea1e684d19
octocode-harness.exe 30f68e660619ff751d0f4b79b551045c26ac00ad5b81ac1c28ca017066fafbc5
```

All four solver rollouts actually used read_file and returned the correct marker.
SSE inspection found four recovered FileNotFound tool updates: INV and DOM each
first tried evidence.txt relative to the isolated conversation directory; Compose's
solver tried that and an incorrect parent-relative path. Each then successfully
read the source-project file. All tools were read-only. This path-recovery behavior
is retained as a concrete limitation, not hidden as an error-free trajectory;
there was no recursion fallback, failed final answer or permission widening.
Details are in `solver-sse-evidence.json` and the actual rollout trajectories.

The private daemon was truly stopped and started again. A new process then
confirmed that the main project's adopted guidance is loaded by the adapter,
the other project uses default guidance and has no adopted file, and the adopted
bytes remain unchanged. A real wrong-project resume request returned HTTP 400;
the original conversation's complete message/event bytes remained identical.
`restart-isolation-result.json` records this check, which made zero additional
model requests. The final native session count remained seven.

Every harness configuration retained context 1048576 and saved high/true/template
reasoning controls. RAM comparison across 13,575 files found zero plaintext key
or API token matches. Python executable/prefix/modules were again physical E with
no reparse points; all 13,084 Python files matched the previously verified E copy
by SHA-256. Authentication reused only that private encrypted profile clone;
no formal database was opened. The private daemon stopped in cleanup.

This validates the final native dependency rebuild with unchanged API/adapter/helper
logic and upstream-LF vendor bytes. Formal installed application/migration and
installer lifecycle evidence remains the release workflow's separate scope.

Before packaging, the twelve original upstream files were normalized from
Windows CRLF to their official LF bytes. Each now exactly matches the pinned
upstream Git blob and the committed source. The ten Python ASTs and recursive
compiled constants were identical before and after normalization; the three
OctoCode runtime source files and both native executables were unchanged.
The source offline suite was rerun: 50 passed and one platform case skipped.

## Final source-path contract regression

The shared API now appends an explicit input/output path contract after task-local
guidance: source reads/list/search use absolute project paths; relative paths
resolve in the isolated conversation output directory. The isolated cwd and
existing permissions remain unchanged. The 51-test suite passes (one platform
skip), and a fresh physical E round completed all seven native sessions with the
correct marker, no stage retry/fallback and zero FileNotFound/tool-error events
in 1941 persisted events. Adoption, daemon restart and wrong-project HTTP 400
read-back checks pass; 13684 files contain no selected key or API-token bytes.

This isolated round's intentionally reduced PATH omitted Git and produced seven
Git executable discovery stderr diagnostics. That is recorded separately from
tool failures, not hidden as a clean log. After adding a physical E copy of the
installed Git runtime to the fixture PATH, one additional native API launch
returned the correct marker with zero error/warning events. The first follow-up
assertion used a misspelled expected marker; comparison against the already
completed persisted answer corrected the fixture assertion without another model
request. No product Git behavior was changed to suppress diagnostics.

Curated results are in `candidate-2.0-security/harness2-final-path-contract/`.
Formal installation and application update lifecycle tests remain pending.
