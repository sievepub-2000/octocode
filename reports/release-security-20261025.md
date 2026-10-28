# 2.0 candidate security acceptance, 2026-10-25

Release remains blocked until the final packaged Windows installation and
GitHub default-branch rescan pass. Source tests do not establish installation
or publication acceptance.

## Electron and Node

Electron 43.8.3 embeds Node 24.22.0 (ABI 148); the separately bundled Node is
26.12.1. They are checked independently. The official Electron archive SHA-256
is `98efbd2d1c7bd44150c0aa800cd9ac5fefcefd2d44fd94958a95d6744d86c6de`.

The actual Electron executable passes nine security regressions: noncanonical
IP identity matching, all DNS resolver NUL boundaries, the upstream Brotli
malformed-block-switch payload, native SPKI revocation, idle and queued HTTP
response poisoning, pinned-CA HTTPS, CONNECT, and pooled streaming fetch.
Four additional tests cover Zod collection bounds, sandbox domain validation,
EventSource field limits and maintained fetch integrity/content decoding.

The subsequent actual branded-product test found an additional release blocker:
the ASAR writer used the Vinyl application-root-relative path instead of the
node_modules source-root-relative path. The archive therefore contained an
extra node_modules prefix, unlike its unpacked sibling, and the actual fork
entry failed to load Undici. The shared packer now uses one validated relative
path for both destinations. A real archive regression reproduced the old
failure and three corrected archive tests pass. This does not clear the gate:
the full product must be repackaged and its security tests rerun unchanged.

The corrected full product subsequently passed all thirteen attacks. Its eighteen
unpacked native modules exposed a second packaging issue: post-archive PE
branding changed resource bytes after ASAR recorded their size and integrity
blocks. The shared Windows dependency transform now brands a private temporary
copy before ASAR consumes the final buffer; original dependency files remain
unchanged. Later branding skips only those already processed root dependencies.
Nine archive/branding tests pass, including real PE reproduction, complete block
hash agreement, native loading, signed-input handling and temporary-file cleanup.
The final product still requires repackaging and these byte checks after this fix.

TLS SPKI and Chromium-linked Brotli have native fixes. DNS/TLS input validation
and legacy HTTP socket retirement are application mitigations, not claims that
all upstream native Node patches are present. Legacy Node HTTP/HTTPS sockets
are not reused; extra handshakes may cost latency. Maintained Undici 8.12.3
continues to pool model-style streaming connections.

Electron uses its built-in Node browser snapshot. The product does not support
custom user Node startup snapshots or Node permission mode. Eight isolated
actual browser-main cold starts checked random values, flags and permission
state; this configuration evidence does not certify arbitrary custom snapshots
or permission-mode launches. Such features require upstream patches and new
acceptance.

## Rust

The RustSec database checked on October 25 is revision
`21d909e` (October 24). The desktop CLI, core Host and harness formal lockfiles
each report zero vulnerabilities and zero warnings, without ignored advisories.
The separate Markdown fuzz lock also reports zero.
The retained Windows user-updater metadata lock was separately audited and its
anyhow dependency updated to 1.0.103; it now has zero vulnerabilities/warnings.
This release is the Windows system installer. Its update path uses the regular
installer and does not invoke the user-only background updater executable.

russh is upgraded to actual upstream 0.64.1 while retaining the reviewed local
RSA/OpenSSL and relay/channel changes. Other affected cryptography, certificate
and Tokio dependencies are updated to patched versions. Yanked harness versions
are replaced within the existing dependency constraints. Final native rebuilds
and packaged regressions remain release gates.

## GitHub alert mapping

The fresh pre-push snapshot contains 265 alerts (231 npm, 34 Rust), mapped in
`security-alert-map-20261025.json`. Four braces entries retain upstream version
3.0.3 under the explicit `@octocode/braces-security` fork identity. For all four
installed dependency copies, JavaScript bytes match the reviewed vendor source.
Actual E-drive fixtures ran all three regressions against each copy: ordinary
glob behavior, deep strings and caller-supplied deep ASTs, twelve passes total.
Evidence is retained locally under
`E:\Program Files\octocode\test\security-braces-20261025`. Version-range mapping
alone deliberately flags these four as requiring patch evidence; it does not
pretend an unmodified upstream 3.0.3 is safe.

## Remaining gates

- Final packaged bootstrap coverage and real product regressions.
- Clean Windows installation in `E:\Program Files\octocode`, restart and
  persistence, native terminal, model, marketplace and private signed updates.
- Default-branch GitHub Dependabot rescan after publishing the reviewed source.
- Downloaded release asset signature/hash verification and source independence.

Linux/macOS OctoCode installation and Docker deployment are not executed by this
Windows release acceptance. The separate macOS oMLX remediation has its own
version-bound evidence in `maintenance/omlx/NATIVE-DEV.md`.
