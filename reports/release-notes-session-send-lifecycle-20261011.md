# Session send lifecycle and failure handling — 2026-10-11

Session operations now emit successful archive, unarchive, delete and rename notifications only after an available provider completes the operation. Batch deletion continues later provider groups while preserving the first rejection, including `undefined` or `null`. A missing provider is checked before clearing the current draft, and cancellation after model resolution prevents configuration setters from running. A secondary draft-cleanup error is logged separately without replacing the original failure.

Each send that owns view-follow behavior now has an independent attempt identity and a matching finished event in `finally`. Failure and cancellation release that attempt's subscriptions. An older completion cannot release a newer concurrent send, even when both use the same session and options object. Existing success notifications remain success-only. Cancellation observes late provider results; this does not assert that the backend itself has stopped.

The change adds 14 permanent cases in the existing management-service suite. The actual Source browser run passed 87 cases with two pre-existing skipped cases unchanged. The private publication dependency variant passed the 14 new cases. These are validation-case counts, not counts of independent defects. Both Source and private complete import closures contained 2,009 non-declaration files / 2,452 total inputs and returned zero type diagnostics. Direct installed ESLint checked the four changed TypeScript files successfully. The independently differing private `async.ts` and common `quickInput.ts` dependencies were tested as their actual private variants and are not included in this change.

Both browser jobs used the existing 120-second run budget and 30-second cleanup boundary, completed without a timeout, and verified cleanup. All six temporary JavaScript outputs were restored byte for byte after each run. The only recorded browser console error in each run was its test-page favicon 404. These local tests use the real management/view services with isolated providers and promises; they do not establish installed-product GUI, real-provider, user-database, Native or production acceptance.

Evidence: `D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/background-six-source-repair-main-20261011T1037/`.

- `STANDARD-VERIFICATION.json`: SHA-256 `309cad36010e2b26463363cc0078a87330d536961b69ead58fdd75aa665d77f7`.
- `SOURCE-FULL-TYPES.json`: SHA-256 `91fdc985e74f766ddd296bfb02bc7d6b22ee4bbc9c56154429dfbf1707f8852f`.
- `PRIVATE-FULL-TYPES.json`: SHA-256 `9743a657ba31038959a4c9f5e5473d91839d1e1eaab54157a7ff325dc537cdcb`.
- `EXACT78-COLD.json` binds the original 78 comments to nine original reports, closed sessions, proofs and complete historical Source bytes. Current changed Source is recorded separately and receives no inherited audit coverage.

Earlier candidate type failures and MAIN evidence-reader failures remain preserved. The current changes require a new scoped audit gate and review of their current hashes. Production installation and the full audit remain incomplete.
