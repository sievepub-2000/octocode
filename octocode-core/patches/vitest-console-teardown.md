# Vitest console teardown backport

`vitest@4.1.12.patch` backports the runtime fix from upstream
[PR 11619](https://github.com/vitest-dev/vitest/pull/11619), commit
`a60b8e1325b34da365c8c30c79321b8ecf566f11` (2026-10-16).
The installed stable 4.1.12 predates this fix. This is a development dependency;
it does not alter the extension or the packaged production runtime.

The log has already been delivered when the worker closes before its RPC
acknowledgement. Only `EnvironmentTeardownError` from that acknowledgement is
handled; other RPC failures are rethrown. Run
`node scripts/test-vitest-console-patch.mjs` to check both branches against the
actually installed patched package, then run the full extension suite.

Remove this backport when upgrading to a stable release containing PR 11619.
