# Release signing

The committed `release-public-key.json` and the generated native/core
`releaseTrust.ts` files identify the same Ed25519 public key. Its fixed SHA-256
fingerprint covers the DER SPKI bytes, not a rotating TLS certificate.

The private key is stored only in
`E:\Program Files\octocode\data\signing\ed25519-private.dpapi`.
DPAPI binds it to the current Windows identity. The directory has a protected
ACL granting only that identity and SYSTEM full control. Neither the private
key nor its encrypted file belongs in source, installers, reports or uploads.
Preserve this runtime data when removing local development copies.
Signing checks the existing owner without changing it and refuses an unfamiliar
owner. Signing and release-output paths must not traverse reparse points.

Use the already provisioned product Python with `cryptography`:

```powershell
$python = 'D:\gpt-workspace\octocode\source\desktop-shell\.build\environments\python\python.exe'
& $python -W error -m unittest discover -s maintenance/release-signing -v
& $python maintenance/release-signing/sign_release.py init
& $python maintenance/release-signing/sign_release.py build `
  --installer 'ABSOLUTE-RELEASE-DIRECTORY\OctoCodeSetup.exe' `
  --extension 'ABSOLUTE-RELEASE-DIRECTORY\octocode-0.1.11.vsix' `
  --version 2.0.0 --tag v2.0 --output 'ABSOLUTE-RELEASE-DIRECTORY'
```

`init` is create-only and verifies the existing identity on repeat runs. A
committed public anchor without the matching local private key is an error;
it is never silently rotated. `build` checks the actual installer product
version, reads the real VSIX package version, hashes the existing artifact
bytes and produces `octocode-release.json` plus its raw 64-byte detached
signature. It refuses to overwrite different existing outputs. Upload both
files together with exactly the installer/VSIX artifacts they describe.
Do not sign fixture installers with the production key.
Size/mtime and file identity snapshots cover metadata reads, hashing and signing;
a concurrently changing build artifact is rejected rather than signed for upload.

The tests generate their own temporary identities and sign a non-release
message. They exercise actual DPAPI, create-only behavior, Ed25519 verification
and tamper rejection without signing any false production manifest.
