# Workspace picker action lifetime — 2026-10-11

Replacing a workspace-picker trigger now closes the popup owned by that trigger. A per-show anchor token prevents an older delegate from clearing the current owner, and replacing one picker's trigger leaves another picker's popup open.

An accepted remote-host Manage action now belongs to the picker lifetime rather than the render lifetime. It survives an unrelated trigger re-render at the same original one-millisecond delay, remains canceled on picker disposal, and checks that its captured provider is still registered before opening its options.

Five new permanent cases exercise real flat/tabbed ActionList DOM ownership and the actual Manage-row dispatch path with the existing fake-time helper. Source browser results: 58 passing, zero failures. The five new cases also passed with the private publication dependencies. Both complete type closures passed (2,032 non-declaration files, 2,475 total inputs); direct ESLint passed for the two changed files. Four temporary JavaScript outputs were restored after each browser run. All existing test-file bytes remain unchanged as the prefix of the expanded suite.

Evidence: `D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/picker-lifetime-source-repair-main-20261011T1156/STANDARD-VERIFICATION.json`, SHA256 `bdbe3a3fa29dc39fc6d58bd837fd929f7c9e0652af31a65be4672089b2eb6de4`. Product SHA256: `0fe6ae41dd1c69a3060e82146d356cd999db48d273f19f9a562ab1c8d5f58d7c`; permanent-test SHA256: `a7a684786056518fe7bbf1dfeabbd7d379a7703126bdd6a82db5d6fc0da05de1`.

The timer tests observe the final invocation boundary without executing real host options or changing host records. These results do not constitute production GUI, mobile-device, connection-timeout, full-audit, or installer-upgrade acceptance.
