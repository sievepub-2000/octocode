# Last-value cache state and regression assertions — 2026-10-11

`LRUCachedFunction` treated its initial undefined key as a cache hit, so a first
undefined identity or custom key skipped the computation. It also committed a
new key before computing its value; a thrown computation could leave that key
paired with the previous value. The cache now tracks whether a value has been
computed and commits the key and value together after successful computation.
Computed undefined values remain cacheable. The three current production call
sites use string or array keys; this batch does not claim an observed user-facing
failure at those call sites.

Four permanent cache cases cover undefined identity/custom keys, computed
undefined values and preservation/retry after a thrown computation. Three
existing assertion tests now require the supplied error to be thrown, preserving
their exact instance and message checks. Two bounds assertions were added to the
existing buffer set test; no buffer implementation change was required.

Validation:

- The first standard Chromium run reported 38 passing and four failing. The
  legacy browser assertion shim performs `instanceof` before invoking an error
  predicate, so the new arrow predicates failed. Only those four new predicates
  were changed to ordinary functions; the original failure remains recorded.
- The final Assert and Cache files passed all 11 cases. The unchanged Buffer
  file had already passed all 31 cases in the original run and was not rerun.
  These establish 42 distinct cases across the final three test files, not 42
  defects or a single all-green original run.
- Eight relevant cases passed using the private publication dependency variant.
  Six independent differences in async and quick-input dependencies were
  compared and excluded from this source batch; the private browser control
  used the publication's actual dependency bytes.
- Actual Source and private candidate dependency closures each contained 1085
  non-declaration files and 1516 total inputs, with zero TypeScript diagnostics.
  These checks were rerun after the two test file hashes changed. The installed
  ESLint CLI checked the four files with the Source configuration and returned
  zero errors and warnings. No dependency installation or `pnpm exec` was used.
- All three browser processes ran in the existing private Job mechanism with
  the original 120-second test bound and 30-second cleanup allowance. Each
  exited without timeout and cleanup was verified with no remaining Job members.
  All ten declared temporary JavaScript outputs were restored to their original
  complete bytes. Each browser console 404 was traced to its page favicon.

The evidence is retained in `base-cache-source-repair-main-20261011T082550614730Z`
and `base-cache-source-repair-r2-main-20261011T083741117421Z`, including the failed
run, exact original opinions, full byte reversals, compiler inputs and runtime
logs. The original opinions and candidates remain under
`owned/20261011-whole-partial-exact-dispositions` and the independent candidate
validation under `owned/20261011-base-cache-candidate-validation`.

Only four TypeScript files and this note are included in this private source
batch. Component HEADs and staged entries are preserved. This batch does not deploy the
installed application or complete full audit, every exact opinion, permissions,
SDK/Native, platform lifecycle, installer or final in-place Upgrade acceptance.
