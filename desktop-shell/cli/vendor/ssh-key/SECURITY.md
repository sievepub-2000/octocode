# Local RSA backend migration

This is RustCrypto ssh-key 0.7.0-rc.11, commit
`7a1c757d2e2fcde32680e373d5226481de6d434e`, with its real package version and
Apache-2.0/MIT licenses preserved. All non-RSA parsing and algorithms are unchanged.

RUSTSEC-2023-0071 has no fixed RustCrypto RSA release. The RSA feature now uses
vendored OpenSSL 4.0.3 through openssl 0.10.81 instead of the affected rsa crate.
RSA key generation, PKCS#1 v1.5 SHA-1/SHA-256/SHA-512 signing and verification,
and SSH RSA key/certificate support remain available. The native implementation
provides RSA blinding and constant-time private operations. Key generation uses
OpenSSL's operating-system-seeded CSPRNG, rather than the supplied Rust RNG.

The RSA component conversions validate the private key before use. OpenSSH wire
encoding, supported key sizes, and secret component zeroization remain in place.
Secret native integers use secure allocation and constant-time flags; temporary
secret byte vectors are cleared on drop. The CRT coefficient equality typo is
corrected so different CRT coefficients compare unequal.
Russh's RSA PKCS#1/PKCS#8 imports and exports use the same native backend.
No package is renamed or assigned a fake fixed version, and no advisory is ignored.

The sibling openssl-sys copy selects the official OpenSSL 4.0.3 source release
and preserves MSVC static debug information. See `../openssl-sys/SECURITY.md`.

The CLI lock includes the maintained native keyring stores, zbus 6, ZIP 9, and
current patched HTTP/QUIC/TLS dependencies. Validation evidence is recorded under
the project's `work/cli-finish-20261018` audit directory.
