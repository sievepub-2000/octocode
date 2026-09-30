# Windows2 bounded native permission audit

Verified 2026-10-01 using local execution, hostname `zillafan80`, interface
`192.168.10.2`, shell working directory `C:\Users\FPP`. The probe directory is
`D:\gpt-workspace\octocode\source\maintenance\verification`, not the parent
project's maintenance directory. Direct self SSH authentication is unnecessary.

## Contract and findings

Current exposed settings source (`octocode-core/webview-ui/src/components/settings/AutoApproveSettings.tsx`)
binds the review/directory/full choices to localized labels. English
`settings.json:390-392` says Review is read only, Directory is read only until
workspace isolation is available, and Full is unrestricted automatic execution.
Chinese `settings.json:305-307` expresses the same limits. `common.json:71`
documents that saved permissions affect subsequent tasks. These are source-level
UI checks; this bounded run did not inspect a rendered production settings panel.

Native `octocode-core/crates/octocode-host/src/agent.rs:93-103` explicitly maps
Full to `bypassPermissions`; a read-only request restricts tools for that turn.
Review and Directory map to `dontAsk` plus `read_file,list_dir,grep`. The source
comment deliberately defers writes until approval forwarding and workspace
isolation exist. Directory currently promises a read-only fallback, not writes
inside a directory or isolation of reads. No stronger promise was found in the
inspected README/interface-contract documents. Outside reads are a residual
scope limitation, not a violation of the current explicit fallback label.

The old probe treated every outside write as forbidden, including Full. That
assertion contradicted the exposed Full contract and actual bypass policy. It
now expects an isolated outside write to succeed only for Full without the
turn's read-only flag. Native implementation was not changed; no concrete
native defect was established by these cases.

## Actual native evidence

Both executables came from `source/octocode-core/src/bin/win32-x64`:

- Host SHA256: `2C468E62AE0159A34FFF1C1EE083C7C483EB7D5D6F94489840A25595AB4483D4`.
- Harness SHA256: `954656605D696B06D506EF767B76B244D2E8A71979172D34AAE1639F41DB382E`.
- Harness version output: `octocode-harness 1.0.16 (6dedbbe70cf4)`.

`permission-read-probe.py HOST HARNESS` passed 16 cases: Review/Directory,
read_only false/true, inside/outside workspace, relative/absolute paths.
Outside relative paths deliberately use parent traversal. Every case required
the native `read_file` result returned to the HTTP model to contain a fresh
random fixture token, absent from the prompt and all stub response content.
Every fixture remained unchanged. Offered tools were exactly read_file,
list_dir, grep and internal session_title. This establishes executed native
reads rather than a model claim or tool-catalog-only check.

Additional real native write probes passed:

| Profile / request | Attempt | Observed |
| --- | --- | --- |
| Full, read_only false | Shell write outside cwd | Marker created |
| Review, read_only false | Adversarial shell write outside cwd | Marker absent; shell excluded |
| Directory, read_only false | Adversarial shell write outside cwd | Marker absent; shell excluded |
| Full, read_only true | Adversarial shell write outside cwd | Marker absent; shell excluded |
| Full same-session two-turn | Read-only write attempt, then authorized write | First blocked; resumed write succeeded |

The HTTP model is a controlled stub, including an approving command-classifier
response. Host RPC, process launch, harness permission filtering, tool execution
and filesystem effects use the actual native binaries. Tests inspect native
tool-result messages and filesystem state; policy enforcement is not mocked.
These cases do not establish list_dir/grep path behavior or all possible tool
escapes, and do not constitute a full installation/system audit.

All records, database, harness home and inside/outside fixtures use isolated
TemporaryDirectory roots. The finally block closes and waits/kills the test
Host and shuts down the HTTP server before TemporaryDirectory cleanup, including
assertion failures. Outside means outside test cwd but still inside its owned
temporary root. No production file or database is a probe target; no credentials
or fixture contents are printed on successful runs.

Edits are confined to `maintenance/verification/read-only-probe.py`, the new
`maintenance/verification/permission-read-probe.py`, and this report.
