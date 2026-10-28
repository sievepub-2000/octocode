# OctoCode 2.0 acceptance — in progress

Target: Windows x64, desktop 2.0.0, extension 0.1.11, installed at
`E:\Program Files\octocode`. This is a candidate, not a release approval.

## Verified candidate checks

- Core: 397 files / 6238 tests; webview: 155 files / 1628 tests.
- Six opt-in network groups / 13 distinct tests, including actual runtime
  provisioning and a 115-extension market survey, passed using isolated E fixtures.
- Electron source/runtime security regressions: 9 Node and 4 Zod/Undici checks.
  The later branded packaged test found a real ASAR layout blocker; the shared
  packer fix passes four real archive tests and branded CJS/ESM/native loading.
  The final repackaged product passes all thirteen attacks; all 43 unpacked files
  and 18 native modules match ASAR sizes, whole-file hashes and block hashes.
- RustSec: three formal locks and the separate Markdown fuzz lock have zero
  vulnerabilities/warnings. russh Windows suite: 174 passes; product-lock
  tunnel/RSA regressions: 16 passes.
- Newly rebuilt Host/harness: actual HTTP prefill rejection, explicit continuation
  in the same conversation, restart persistence and isolated-record deletion pass.
- Backup: five real Windows DPAPI/AES-GCM/SQLite/ACL tests, including data and
  report-directory escape rejection, pass without reading formal databases.
- Legal inventory: 521 production npm packages, 412 runtime supplement records,
  156 Python distributions and native dependency notices have no unresolved
  entries. Six final VSIX member byte comparisons pass.

## Release gates still open

The first physical clean-install candidate is rejected and must not be published.
The installer copied 2.0.0 successfully but initialization failed on unnamed,
retained Python distribution metadata; setup incorrectly returned zero. Both
causes are fixed, with 15 migration tests and successful installed initialization.
User-data preservation passed before and after installation.

Actual terminal acceptance then exposed missing unpacked ConPTY DLL/executable
files. Repairing those exact archived bytes restored the real VS Code terminal:
keyboard input and Enter executed PowerShell PID 53308 in the formal E workspace.
The production unpack rule and packaged-dependency gate now cover these files.
A rebuilt installer and fresh installed read-back remain required.

The same installed run exposed ordinary Windows project paths being compared
against canonical verbatim-prefixed workspace paths. The Host fix normalizes
only equivalent Windows prefix representations and retains traversal/symlink
checks. A real Windows legacy-path/index-refresh regression passes. The new
Host/VSIX is being rebuilt; the installed projects must still be rechecked.

1. Physical E migration and nine managed-path row changes passed with zero
   missing/outside targets; ten actual encrypted credentials passed restore.
   A resumed installed task's execution directory still requires validation.
2. Complete desktop and signed installer are built. The protected-runtime
   installer is 775293101 bytes, SHA-256
   `08254adabac307277d798295299fde4a8e9b39a3be000c2b60332152044c97fb`.
   This does not establish installation acceptance.
3. Real clean uninstall/install, cold start, runtime identity and source-path
   independence, settings, project/conversation/file/terminal isolation, native
   PowerShell input, tray reopening, marketplace/index and timestamps.
4. Real GLM API acceptance against the final native dependencies and installed UI.
5. Review and push master, then verify every GitHub alert's server-side state.
6. Publish signed private release assets, verify downloaded bytes, exercise the
   update and recovery channels, and verify post-update persistence.
7. Remove only verified obsolete development copies after the remote repository
   and formal E installation are independently usable.

Linux/macOS OctoCode and Docker deployment lifecycles are not executed by this
Windows acceptance. Separate macOS oMLX evidence is in
`maintenance/omlx/NATIVE-DEV.md`; its bounded long-context checks do not establish
all possible 1M-token/concurrency workloads or a physical OS reboot.
