# Tip actions stay with their originating composer — 2026-10-11

The new-session composer previously registered its tip commands with the shared opener service. With two live composers, that registry could send one composer's model-picker click to the other composer. The two existing local actions now travel through the originating tip part's callback. The model picker belongs to that composer; Plan retains its existing local no-op. Other commands continue through the normal opener route.

The tip part checks its trusted-command list before invoking the local callback and checks disposal before dispatch and again after an asynchronous setup action. Disposing a composer while setup is pending cannot dispatch the completed action into another composer. The ordinary chat widget supplies no local callback and keeps its normal route.

Four new permanent browser cases use the actual widget, tip part, markdown renderer, DOM click listener and shared opener. They cover two live composers, disposal, Plan behavior, command allowlists, ordinary command routing and setup completion after disposal. Actual Source passed those four cases and all 15 existing widget cases. The private dependency variant passed the four new cases. Source and private complete type closures each checked 2,009 non-declaration files / 2,452 total inputs with zero diagnostics; direct installed ESLint checked all four changed TypeScript files successfully. These are validation-case counts, not counts of defects.

All three browser runs used the existing 120-second run budget and 30-second cleanup boundary and verified cleanup. Existing JavaScript outputs were restored byte for byte; the newly created test output was removed after matching its exact owned bytes. Each run's only recorded console error was its test-page favicon 404. The tests use isolated input, toolbar and setup endpoints. They do not claim that the installed product's concurrent layout, real provider, user database, Native or production lifecycle was exercised.

Evidence: `D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/tip-origin-source-repair-main-20261011T1051/`.

- `STANDARD-VERIFICATION.json`: SHA-256 `f2f1157ccd9b2ea7cf32ad7637ec10e1a3f9248b5176e1fb7da88bc9ea8f11e7`.
- `SOURCE-FULL-TYPES.json`: SHA-256 `2bb66ebff7f17b957fbf99d91e5be9f25f6d0f0949494d7d730be7cd3850ea01`.
- `PRIVATE-FULL-TYPES.json`: SHA-256 `fcc109089ff6228bfb60fa51f7de054daa4b12b5db87cdfd835f9731302db0e2`.

MAIN independently read all 199 sealed worker artifacts and replayed all seven product edit spans forward and backward against current Source, preserving the preceding four widget lifecycle repairs. The private `async.ts` and common `quickInput.ts` differences were tested separately and are excluded from this publication. New Source hashes require a fresh scoped audit. Production deployment and the full audit remain incomplete.
