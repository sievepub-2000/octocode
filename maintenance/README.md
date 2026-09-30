# Current release maintenance

Updated: 2026-09-21, Asia/Shanghai.

The production shape is native Windows OctoCode plus one zillafan-owned macOS
oMLX App. No Docker production environment is introduced.

Build all product stages with `./octocode-build.ps1`. The versioned default
skills are authoritative, and every packaged Host/Harness must match the
freshly built binary. `work/octo-env.ps1` is a tracked build input; other
`work/` files are generated evidence or scratch output.

`verification/backup-current.py` snapshots SQLite via the backup API, restores
into an isolated directory, and verifies DPAPI/AES-GCM credential recovery.
Keep its output private. It intentionally never prints credentials.
`verification/wiki-operations.py` imports only reviewed, non-secret operational facts.

The macOS scripts in `omlx/` run under zillafan. `omlx-current.patch` records
the four minimal overrides against signed oMLX 0.7.0.dev4; the App bundle is
not modified. Apply the patch to a copy of the vendor modules with no fuzz,
then record both vendor and patched SHA-256 values in the override manifest.
`serve.py` enforces those hashes at every startup.

`update-dev.py` checks the upstream Dev channel, release SHA-256, Apple signing
identity and Gatekeeper. Existing override hashes must match before the App
is stopped. If upstream changes an overridden file, the update is held for
review. Do not disable this compatibility gate. The currently installed Dev
is already latest; tests cover compatibility rejection and filesystem
rollback with platform commands isolated, not a nonexistent newer release.

The user LaunchAgent installed by `enable-dev-updater.py` checks every six
hours. Read `dev-update-status.json` and its logs for failures. MTP/settings
read-back and a real tool call gate successful replacement. Old App copies
are removed only after verification. Physical FileVault cold-start and Apple
hardware diagnostics cannot be substituted with a service restart.
