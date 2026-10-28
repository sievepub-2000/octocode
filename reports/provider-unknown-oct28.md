# Provider configuration loss and continuation repair

Historical candidate record. Current 2.0.1 build and acceptance evidence:
[v2.0.1-acceptance.md](v2.0.1-acceptance.md). The 12-round real dialogue passed;
formal installation and online upgrade remain pending in that report.

The installed runtime log from `20261028T031322` records repeated `provider.resolve`
and `harness.continue` failures: `-32602 provider unknown is not supported by the
OctoCode harness`. The affected session selects an existing profile whose stored
configuration contains only its name and ID. Other newly created profiles have
the same incomplete shape. The preserved Nemotron free and GLM profiles still
have explicit providers and models.

`useSelectedModel` supplies an OpenRouter display fallback. The provider settings
screen previously treated that display value as an explicit selection while the
actual `apiProvider` remained absent. Its save schema selected the empty-provider
branch and discarded the entered model and credentials. The native Host then
correctly rejected the incomplete configuration.

The settings screen now displays the actual provider selection and requires one
before submitting a configured model. Saving an unfinished profile preserves its
draft fields. Runtime provider resolution, preparation and continuation reject a
missing provider with an actionable message before native RPC. A conversation's
unfinished profile never silently falls back to another conversation's model.
No missing model, endpoint or credential is guessed or rewritten from its name.

Verification performed:

- Initial regression runs reproduced three failures: discarded draft fields,
  misleading OpenRouter selection, and an unconfigured continuation sent to Host.
- The two focused extension suites passed 86 tests after the repair.
- Provider UI and validation suites passed 67 tests.
- The runtime directory passed 46 tests across six suites. A further regression
  for an unfinished saved session profile passed with the 35-test runtime suite.
- Extension types, lint, build and VSIX packaging passed. Installer preparation
  passed its nine tests and dependency validation.
- A live request using the saved Nemotron free profile returned
  `NEMOTRON_READY`, `finish_reason=stop`, and zero cost. This is an upstream smoke
  check, not evidence of installed session continuation.
- The candidate's pinned Ed25519 signature and both artifact hashes/sizes were
  independently verified.

Candidate artifacts:

- Installer: `releases/v2.0-provider-fix-oct28/OctoCodeSetup.exe`, 777,616,015 bytes,
  SHA-256 `61e9b9d56d51c6b36178b24eb6c9510056532d5d83f0be03e8a95e1311d1e1b0`.
- Extension: `octocode-0.1.13.vsix`, 85,904,078 bytes,
  SHA-256 `8ae12d7c08de7d92cdc7c378c51419e9777fc9ff5b586ae1e58d7caf07342913`.

The normal in-place upgrade remains gated on OctoCode exiting. Windows Computer
Use returned `GetCursorPos failed: Access denied`; normal exit was requested from
the user. The current installed executable has not been force-terminated.

`maintenance/verification/test-installed-nemotron.cjs` prepares 12 actual turns
through the installed extension API: a 400-row synthetic ledger, eleven same-session
continuations, visible-body length checks, remembered-anchor checks, cumulative
balance checks, and successful native completion checks. It reads only the owned
test session, saves its synthetic outputs, and restores the prior model settings
in `finally`. It has not yet run. Its syntax and the companion Python reader were
checked. Do not mark the bug accepted or the release complete until this passes.
