# Local security patch

This is the local `@octocode/braces-security` fork of the MIT-licensed upstream
`braces` 3.0.3 source, with its original version and license preserved. Its dependency
key remains `braces`. GitHub advisory GHSA-vfj7-8cjw-p6xm has no patched upstream
release as of 2026-10-14.

The parser limits brace and parenthesis nesting before building a deep AST. The
compile, expand, and stringify walkers also limit depth for callers supplying an
AST directly. Nesting at 128 levels is rejected with a catchable `SyntaxError`
before recursive traversal can exhaust the JavaScript stack. Normal glob and
range syntax is unchanged. This limit is mandatory and cannot be disabled by
options.

The workspace uses this source through a pnpm `file:` override; no published
version is relabeled as a fixed release. Run `node --test vendor/braces/security.test.cjs`
from the workspace to verify attack inputs and ordinary patterns. Replace this
local copy when upstream publishes and verifies a fix for this advisory.
