# Signed private updates

The user confirmed a compiled release-signing public key and its SHA-256
fingerprint. Tokens remain in the existing encrypted GitHub credential store.
The native updater is primary. An extension command independently downloads a
full installer as recovery when the native updater fails. Neither path bypasses
signature validation, dirty-document protection, active tasks, or normal quit.

Official GitHub releases contain `octocode-release.json` (UTF-8, at most 1 MiB)
and `octocode-release.json.sig` (the raw 64-byte Ed25519 signature over the exact
JSON bytes). Verify before reading hashes. The compiled fingerprint is SHA-256
of the DER SPKI public key. GitHub's rotating HTTPS certificate is not pinned.

```json
{
  "schemaVersion": 1,
  "product": "OctoCode",
  "repository": "sievepub-2000/octocode",
  "version": "2.0.0",
  "tag": "v2.0",
  "assets": {
    "windows-x64-system": {"name": "OctoCodeSetup.exe", "sha256": "64 lowercase hex digits", "size": 123},
    "extension": {"name": "octocode-0.1.11.vsix", "version": "0.1.11", "sha256": "64 lowercase hex digits", "size": 456, "minShellVersion": "2.0.0"}
  }
}
```

Bind repository, tag and normalized product version to the release metadata;
bind each selected asset name and size to exactly one real release asset.
Validate its signed size and SHA-256 after download. A supplied GitHub digest
must also agree. Missing signatures fail closed on the official channel.
Recovery permits same-version repair, rejects downgrade, and obtains the real
product version independently of the VS Code API compatibility version.

Keep the private Ed25519 key DPAPI protected under the preserved runtime data
directory, outside source, installers and reports. Restrict its directory to
the current Windows identity and SYSTEM. Generate it once; subsequent signing
must match the committed public trust anchor. No token or private key is a
build input distributed with the application.
