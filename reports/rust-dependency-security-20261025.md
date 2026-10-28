# Rust dependency security refresh

The GitHub snapshot contained 34 open Rust alerts. Current source already fixed
32 by real dependency versions. Two still affected the vendored russh 0.63.3:
GHSA-j7h2-66j4-ghjf (authentication signature algorithm mismatch) and
GHSA-4wc5-f2rc-q74m (unbounded agent lifetime-constraint tasks).

The CLI now uses actual upstream russh 0.64.1, archive SHA-256
`ba61e87b9ec9a39a59a6bbed4c0b8ff7fb07073405b24a767a1f2c8560ac8f58`,
upstream commit `e5d80a07dc554480b6ea3b2e14adfc190407b627`. Eleven existing local
patch files were three-way merged against official 0.63.3 and 0.64.1 archives
without conflicts. RSA uses the maintained OpenSSL backend; key formats, relay
negotiation and single channel rejection remain patched. The product lock has
no `rsa` crate. Versions were not relabeled to conceal backports.

Latest official RustSec database commit
`21d909e4c8bd4e14c7aea58bf980c881a0053ab1` (2026-10-24) exposed additional
problems absent from the GitHub snapshot. Real compatible package updates fixed
them without advisory ignores:

| Lock | Updates |
| --- | --- |
| desktop-shell/cli | russh 0.64.1, crypto-bigint 0.7.8, ctutils 0.4.5, rustls-webpki 0.103.16, webpki-root-certs 1.0.11 |
| octocode-core | tokio 1.53.3, fixing the Unix AsyncFd unsoundness warning |
| octo-harness | ctutils 0.4.5, rustls-webpki 0.103.16, webpki-root-certs and webpki-roots 1.0.11; yanked packages replaced by aes 0.9.3, chacha20 0.10.2, clipboard-win 5.4.3 and spin 0.9.9/0.10.1 |

Cargo-audit 0.22.2, including live registry yanked checks, reports zero
vulnerabilities and zero warnings for all three product locks. The markdown fuzz
lock also reports zero. Raw reports and the 34-alert mapping are in
`source/work/rust-audit-oct25/`; GitHub's actual post-push alert state requires a
separate server-side refresh and is not inferred from these local results.

Upstream removed `desktop-shell/cli/vendor/russh/src/keys/format/pkcs8_legacy.rs`;
the flattened release tree must delete that path too. Standalone vendored test
Cargo.lock is not a product lock and must not be included in the release tree.

Windows bundled Rust 1.98 ran the selected russh library suite: 174 passed,
zero failed or ignored. This includes upstream signature-algorithm mismatch
rejection and matching-algorithm acceptance; the new agent regression verifies
duplicate, unknown and truncated constraints neither insert a key, acknowledge
success nor leave a task behind, while a valid constrained key expires normally.
The test-only standalone lock is retained under work, outside the vendor tree.

The actual CLI product-lock tunnels suite passed all 16 tests, including RSA
sign/verify and private-key formats, real TCP relay channel transfer/refusal/close,
and encrypted/mixed-client rejection of a downgrade to keyless relay mode.

The first Windows release build completed in 8m41s. Output:
`source/work/rust-audit-oct25/target/release/code.exe` (28,929,536 bytes), SHA-256
`a2c3d6f5e460fe8ba23ae7f5e6b758aa60a70fd4764af2f734df590ea570f4d8`.
Its development smoke reports OctoCode 2.0.0, embedded desktop commit
`8a360b032b91b88193e29baface4be977767c17f`. A final commit relink is pending;
this hash is explicitly the initial build, not the final installer artifact.

Build commands are recorded in `work/rust-audit-oct25/test-russh.cmd` and
`build-cli.ps1`. They use the source-bundled Rust 1.98, D-drive MSVC and Perl,
`--locked`, two release compilation jobs and the source environment loader.
The release uses the same-source OpenSSL 4.0.3 static cache built with `/O2 /MT`;
the actual openssl-sys link directives point to that D-drive installation and
request static libssl/libcrypto. The link map contains the crypto object code.
PE imports contain only Windows OS libraries, with no external OpenSSL or VC
runtime DLL. Library SHA evidence is in `openssl-cache.json`; binary, import and
link evidence is in `cli-build-result.json`, `cli-pe-imports.txt` and `cli-link.map`.
No formal installation acceptance is inferred from this development build.

The existing checksum-verified notice collectors refreshed the actual shipping
native legal texts: CLI covers 496 third-party package instances, harness 1234
registry versions and in-tree notices, and Host exactly all 88 locked registry
versions. Missing coverage is zero. Source notices use LF, and the core's copied
harness notice is byte-identical. Current coverage and lock/hash evidence are in
`source/work/cli-finish-20261018`, `rust-finish-20261018` and the Host notice JSON.
Desktop aggregation and VSIX/payload copies must be regenerated and checked after
these new artifacts; old attributions remain preserved as historical sections.

The final CLI relink embeds the actual desktop build revision
`1cfae726889f82bd4d99470b54cc895cb8d25d9c`, CLI Git tree
`e675916dcc01b1ab86a7c3ae8a2aa888adfa7256`. Its SHA-256 is
`d0a56225a77dfce7e99d9ccffed8d6b4967e8ea992e4be6f40cf632c1d9e29c6`.
The canonical checked input is `desktop-shell/cli/target/release/code.exe` plus
its `.build.json` receipt. The sole Windows product destination is
`bin/octocode-tunnel.exe`; current product configuration does not enable
versioned-update layout. Actual final `--version` and PE imports were rechecked.

Tracked reproduction is `maintenance/build-native-cli.ps1`; tracked guard tests
are `maintenance/verification/test-build-product-safety.ps1`. All 26 cases passed
under PowerShell 7.6.5 and Windows PowerShell 5.1. Fixtures execute from E, use
real nested and flattened isolated Git repositories, and clean up in `finally`.
Version-subprocess behavior is separately exercised with a real copied Node;
synthetic CLI receipt cases stub only that subprocess. Production was untouched.
These build revisions identify the actual compiled source and do not claim to be
the later flattened master commit.
