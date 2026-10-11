# Background send failure listener cleanup — 2026-10-11

The new-session composer returned immediately from a background send, but a later
`createNewChat` or `sendRequest` rejection never released that send's success
listener. A reused composer could retain pending sends indefinitely.

The session management service now emits a failure event with the original send
options object. The widget groups the success and failure listeners into one
disposable store per send. A matching failure releases both listeners and retains
feedback in its existing accepted state for a later send. This batch asserts
retention; it does not execute a failed-send-then-successful-retry round trip.
A successful send keeps the existing feedback removal
behavior. Unrelated send options and notifications after widget disposal do not
affect the pending state. The navigation test service implements the new event.

Four permanent regressions exercise the actual widget and management service
with controlled providers: create failure, send failure, concurrent/foreign
options, and late failure after disposal. The existing seven widget test
statements are byte-for-byte preserved.

Validation on the applied Source:

- Standard Chromium widget and navigation suites: 28 passing, command exit 0.
- Installed ESLint CLI using the actual repository configuration: exit 0 with
  `--max-warnings=0`; no `pnpm exec` or dependency installation.
- Selected product and permanent test dependency closure: 2010 source files,
  2453 total inputs, zero TypeScript diagnostics.
- Publication source closure: the same file counts and zero diagnostics. Its
  independently unpublished `async.ts` and `quickInput.ts` differences are not
  included in this batch. The four new cases also pass with the publication's
  actual `async.ts` implementation.
- Six temporary JavaScript outputs were restored to their original complete
  bytes after validation. No component HEAD, index, or pre-existing TypeScript
  changes were reset.

The initial permanent test proposal produced three type diagnostics because its
subscription helper passed an add-only test facade where an actual disposable
store was required. The final fixture owns a real store; the original failed
report is retained. The earlier runtime proposal's syntax failure and all
original audit reports are also retained. The browser console 404 was traced to
the test page favicon; complete network logs are preserved.

Evidence root on this Windows audit host (absolute path, forward separators):
`D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/background-send-source-repair-main-20261011T0711`.
These are preserved validation receipts from this batch, not a fresh check of
later Source changes or production deployment:

- `STANDARD-VERIFICATION.json`: SHA-256 `be92c87750d9d936afc57b6642a53fc24ab1410cdf60c2c4ef9f64d02f2b8f26`.
- `SOURCE-APPLIED.json`: SHA-256 `bc24601999d59dc2fccdc2a8d7ad7bc072edcaf951322a1021d899aa92a6c4b0`.
- `SOURCE-FULL-TYPES-r3.json`: SHA-256 `4808094a06d6cbd6787eb5e9e5c22c210b8e8711609e1556ab78d0a2286cd3f0`.
- `PRIVATE-FULL-TYPES-r3.json`: SHA-256 `1f686c6fd341fb123c1ea3bb2aed5ffa872b314bdc49ec63263309e974262634`.
- `OWN-OUTPUTS-RESTORED.json`: SHA-256 `512a33fd75f27089a22d12452b14d0f85a91754705093bd09d4ea699cf2847df`.

Original exact opinion
`05e57c2bdf264119bd812880da083e5a2d31a417d9baa870331c06c7614009a2#comments[0]`.
The 32 passing cases are 28 Source cases plus four publication-dependency
cases. They are validation cases, not an opinion-disposition count. This batch
repairs one runtime defect. These tests use controlled
providers and storage; they do not validate the installed application, live
models, user databases, Native behavior, or all supported platforms.

Only these five TypeScript files and this note are in this private source batch.
Production remains 1.132.2 / extension 0.1.8. Full audit, exact-opinion disposition,
Core dependency integration, SDK/Native acceptance, installer preparation and
the final in-place Upgrade remain incomplete.
