# OctoCode braces security fork

This MIT-licensed fork retains upstream braces 3.0.3's version and API. The package name identifies this maintained fork; consumers install it under the existing `braces` dependency key.

Upstream source: https://github.com/micromatch/braces/tree/3.0.3 . Original LICENSE and README are retained.

GHSA-vfj7-8cjw-p6xm is fixed by limiting recursive nesting in parse, compile, expand and stringify to 128 levels. String input and caller-supplied ASTs receive catchable SyntaxError failures instead of terminating the process with stack exhaustion.

Run `node --test vendor/braces/security.test.cjs` from the desktop-shell root. It covers normal glob/range/escape behavior, balanced malicious input shorter than upstream's MAX_LENGTH, and caller-supplied deep ASTs.

Local packages must be installed with npm's `install-links=true` to pack their code and install their dependencies. Do not restore registry braces without an upstream fix and the same attack regression tests.
