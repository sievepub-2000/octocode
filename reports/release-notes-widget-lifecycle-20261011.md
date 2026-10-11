# Widget creation and selection lifecycle repairs

This batch fixes four ownership and asynchronous selection paths in NewChatWidget:

- A disposed creation holder now cancels and releases a newly allocated lifecycle
  immediately, before calling the service or subscribing to provider changes.
- A provider-change listener is released when its draft was sent or is no longer
  active. Waiting for a preferred provider that has not connected remains valid.
- An older workspace trust result cannot clear a newer selection of the same URI.
- An acquired empty-state renderer is disposed if rendering throws before its
  ownership can be returned to the caller.

The existing test fixture also checks its reflective service dependencies before
using them. Three obsolete review-number prefixes were removed from comments.
The background-send release note now distinguishes case counts from findings,
states the tested feedback-retention boundary, and gives complete evidence paths.

Validation used the actual Desktop Source and the private publication dependency
variant. Both complete type closures passed: 2,009 non-declaration files, 2,452
total inputs and 2,493 recorded compiler reads per variant. Direct installed
ESLint passed both changed TypeScript files without warnings.

The first Source browser command passed 11 cases and failed four existing
background-send cases because MAIN had omitted the current management-service
output from its temporary browser build. After adding that exact service from
the already checked type closure, only those four failed cases were rerun and
passed. The unchanged successful 11 were retained. The four new cases also
passed using the actual private dependency variant. These are 15 distinct
Source cases and four private cases, not 19 defects or one all-green initial run.
All three browser jobs stayed within the original 120-second bound with the
original 30-second cleanup allowance. Their owned process cleanup and temporary
output restoration were verified. Each observed console 404 was the test-page
favicon; complete network logs are retained.

Evidence is in
`D:/gpt-workspace/octocode/audit/fresh-review-after-history-20261001/widget-lifecycle-source-repair-main-20261011T1025`:
`CANDIDATE-COLD.json`, `SOURCE-APPLIED.json`, `STANDARD-VERIFICATION.json`,
`BROWSER-PREPARATION-CORRECTION.json`, and `DOC-SOURCE-APPLIED.json`.

The eleven incorrect aliases are corrected in the derived findings index using
their original plan, report, proof, closed session and explicit correction ledger.
Their raw reports remain unchanged for traceability. Editing the release note
does not undo attribution: fresh current bytes are recorded separately and the
old proof is explicitly not counted as a review of the revised note. This does
not close every audit opinion or establish installed production acceptance.

The independent Source/private async and quick-input differences are excluded
from this publication. No component repository commit, package installation,
native diagnostic, production build or deployment is part of this batch.
