# Maintained desktop build dependencies

These are source forks of the actual upstream npm releases, with their original
package names and versions. `UPSTREAM.json` in each directory records the official
registry archive URL, npm integrity, and original file SHA-256 values. Original
copyright and license files are retained. No package version is invented and no
warning is filtered. The build uses these explicit local sources via package.json.

## @vscode/gulp-electron 1.43.1 (MIT)

- Replace callback rimraf with native recursive fs.rm, including retry behavior.
- Replace temp/rimraf with exclusively created UUID temporary files. Release
  temporary files on both normal and error callbacks.
- Use maintained vinyl-fs 4 and explicitly disable transcoding for binary Darwin
  icons/assets/credits. Preserve existing Vinyl and legacy stream interfaces.
- Use rcedit 5's named Promise API, supplied by the maintained fork below.

## gulp-sourcemaps 3.0.0 (ISC)

- Replace css/source-map-resolve with maintained PostCSS 8 for CSS identity maps.
  Traverse nested at-rules, rules, declarations and comments; convert its one-based
  source columns to the source map format's zero-based columns.
- Replace deprecated Buffer constructors with Buffer.from in map read/write paths.
- Existing JavaScript identity mapping, inline/external maps, source content,
  mapSources and public stream interfaces remain available.
- Invalid CSS now produces a parser error rather than a partial silent parse.

## websocket 1.0.35 (Apache-2.0)

- Remove yaeti and use native EventTarget/Event, with the WebSocket onopen,
  onmessage, onerror and onclose attributes and listener replacement/removal.
- Replace legacy url.parse with WHATWG URL, retaining the request query object
  and path fields consumed by the library. Preserve IPv6 brackets in Host headers
  while using an unbracketed hostname for Node's request options.
- Preserve the socket framing, TLS, headers, subprotocol and Node client/server
  APIs used by the dev-tunnels SDK. No network protocol was replaced.

## @microsoft/dev-tunnels-connections 1.3.61 (MIT)

- Preserve the official SDK implementation, wiring only its websocket dependency
  to the adjacent maintained websocket source. A normal relative file dependency
  is used because npm resolves scoped file overrides against the consumer's
  installation directory rather than the repository root.
- SDK JavaScript file headers preserve Microsoft's copyright notice. LICENSE
  reproduces its existing full notice from the product ThirdPartyNotices.txt.

The upstream gulp-electron npm archive and Microsoft repository have no separate
license document. Its LICENSE records the published MIT declaration and author
attribution and provides the canonical MIT text without inventing a holder/year.

## rcedit 5.0.2 (MIT)

- Preserve upstream's resource editor executables and named asynchronous API.
- Validate the input executable header and options before starting the editor;
  reject invalid input without modifying it and always close the input handle.
- Preserve cross-build diagnostics instead of setting WINEDEBUG=-all.
- The two executables in bin/ are original upstream package assets, recorded in
  UPSTREAM.json; they are not locally built/runtime outputs.

## vscode-universal-bundler 0.1.3 (MIT)

- Use maintained @electron/asar 4 through its public namespace API in both the
  CommonJS and ESM entry points; version 4 no longer exports a default object.
- Preserve custom archive paths, comparison exclusions, single-architecture files,
  integrity metadata and the existing native Mach-O merge behavior.
- Accept the native listPackage separator and normalize unpack globs for Windows,
  preserving unpacked native files during real archive merging.
- Real two-archive merging and extraction are tested on Windows. Actual lipo and
  macOS app packaging remain platform validation gates.

## @vscode/deviceid 0.1.5 (MIT)

- Separate the upstream binding.gyp `/ZH:SHA_256` and `/Zi` entries: Python
  concatenated the adjacent strings and MSVC ignored the result. Express `/Zi`
  through DebugInformationFormat=3 (ProgramDatabase) rather than a duplicate
  additional flag that conflicts with inherited `/Z7`. SHA-256 hashing, real PDB
  generation and Spectre mitigation remain enabled and are compiled on Windows.

## @parcel/watcher 2.6.0 (MIT)

- Upgrade to the official 2.6.0 source. Recognize the current package_config
  node-gyp source-build setting as well as the old npm_config setting.
- Invoke the actual npm's node-gyp CLI through process.execPath and argv without
  a shell. The source build must complete before postinstall drops architecture
  prebuild packages; it must not leave the watcher without any native binding.
- Native local sources have exact file-path allowScripts entries. npm 12's
  registry name/version policies intentionally do not authorize file sources.
- Inherit the target runtime's C++ standard on Windows instead of overriding its
  C++20 requirement with C++17. Keep the existing exception and hardening flags.

## @vscode/spdlog 0.15.8 (MIT, bundled fmt license retained)

- Express the bundled fmt UTF-8 detection's FMT_UNICODE constant as a compile-time
  branch. Preserve the original true branch and byte-detection fallback while
  avoiding an MSVC static-analysis warning about two constant OR operands.

## Reproducible native toolchain compatibility

- `build/npm/nativeToolchainPatch.ts` applies strict, idempotent source changes
  during Windows preinstall. It covers both the local node-gyp and the actual
  node-gyp bundled inside the source npm, including clean installations.
- node-gyp 11.2.0/13.0.0/13.1.0 Python discovery passes explicit `.exe` paths and
  argv directly, retaining the existing shell path for batch launchers. Official
  13.1.0 still has the original Windows shell behavior. This removes DEP0190 by
  correcting the invocation rather than filtering diagnostics. Upstream:
  https://github.com/nodejs/node-gyp/blob/v13.1.0/lib/find-python.js (MIT).
- `nativeToolchainPatch.upstream.json` records the original source hashes used
  for review. The local header tool is upgraded to official node-gyp 13.1.0;
  bundled npm's node-gyp keeps its actual package version.
- The downloaded Electron libuv Windows header receives the same NTSTATUS SAL
  success annotation as the installed Windows SDK, conditionally for MSVC. This
  preserves the type and static analysis contract. Upstream libuv headers retain
  their original license; no warning or analyzer is disabled.

## Scoped dependency updates outside these forks

- Kerberos 7.0.0 retains every official source file, its Apache-2.0 license and
  archive/file hashes in `vendor/kerberos/UPSTREAM.json`. Only package.json changes:
  the install script calls node-gyp directly and the deprecated prebuild-install
  production dependency is removed. The product already uses its Promise API;
  removed callback/class exports are unused. Node-API 9 is supported by the
  Electron and remote Node runtimes. No Kerberos protocol code is modified.

- gulp-json-editor 2.6 uses js-beautify 2; JSON structure/indentation verified.
- gulp-symdest and gulp-azure-storage use vinyl-fs 4; binary stream interoperability
  verified. No global vinyl-fs/glob/rimraf override is applied.
- l10n-dev and tsec use glob 13's compatible sync/hasMagic APIs; actual string
  export and exemption parsing are tested.
- vite-plugin-istanbul 9 and its explicit Vite 8 peer use the official maintained
  releases. The Component Explorer CLI resolves this plugin from the root, so a
  Vite installation in the separate build/vite project does not satisfy its
  runtime import. Actual instrumentation is covered by the build probes.
- Sinon 22 is used with explicit timer lists in existing test call sites, so the
  test runner's microtasks remain native. Mocha and c8 use maintained releases.

## Verification

`build/lib/test/asar.test.ts` and `maintainedDependencies.test.ts` exercise actual
archive extraction, equal-content files, order/unpack/skip/duplicate behavior,
Windows PE edits, WebSocket loopback events, CSS source maps, localization export,
exemptions, coverage instrumentation, binary streams, timers and cleanup errors.
Linux/macOS deployment execution is not established by these Windows tests.
