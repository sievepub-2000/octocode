# Workspace picker admission and accessible names

Batch 23 fixes two confirmed workspace-picker defects. A rejected asynchronous
workspace admission check now reports the error and leaves the previous workspace,
recent records and automation model unchanged. Flat and tabbed browse choices use
the platform action list's accessible names, retaining each provider's host
description instead of announcing only the shared Select label.

Five permanent regression cases cover recent and browse admission rejection, the
automation model boundary, and both rendered picker variants. The two accessibility
cases use the production list DOM and dispatch the selected host's real picker
action. The original 48 test statements retain their exact bytes.

Validation on the changed Source: 53 browser cases passed, the complete relevant
TypeScript closure passed with 2,032 non-declaration / 2,475 total inputs, and direct
ESLint passed with no added suppression or configuration change. The private
publication dependency variant passed its complete type check and all five new
browser cases. Independent unpublished async and quick-input changes are excluded
from this batch. Both browser jobs used the existing 120-second bound plus original
30-second cleanup bound, verified cleanup, and restored seven temporary JavaScript
outputs to their original bytes. The two console 404 entries were traced to the
test pages' favicon requests.

Initial verification-reader failures are retained: concurrent evidence copies
collided, and the first private type-reader could not bind a compiler input. The
successful checks use separate evidence directories and an explicit private
compiler input reader with full text read-back; no product check was weakened.

The initial staged whitespace check found one new empty line at the test file's
end. Only that final CRLF was removed. The final test file produces byte-identical
JavaScript to both already executed browser variants; those successful runtime
controls were not repeated. Types and ESLint were rerun for the final Source bytes.

The current audit opinion index also now explicitly corrects eleven malformed
reported aliases against their unique original plan, closed session, proof and
current Source bytes. Original reports and comments remain unchanged. This repairs
attribution and adds no AI coverage or automatic opinion closure.

This batch does not claim installed-product GUI, real provider, user-database,
Native, platform lifecycle, complete audit or installer acceptance. Production
deployment remains a later in-place Upgrade after the required acceptance work.
