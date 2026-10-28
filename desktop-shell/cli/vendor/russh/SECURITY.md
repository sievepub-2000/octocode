# Local relay protocol and RSA backend compatibility patches

This is the upstream Apache-2.0 `russh` 0.64.1 source, published from commit
`e5d80a07dc554480b6ea3b2e14adfc190407b627`. Its real version is unchanged.
The official crates.io archive SHA-256 is
`ba61e87b9ec9a39a59a6bbed4c0b8ff7fb07073405b24a767a1f2c8560ac8f58`.
It includes the upstream fixes for GHSA-j7h2-66j4-ghjf (authentication signature
algorithm must match the request) and GHSA-4wc5-f2rc-q74m (validate constraints
before insertion and spawn at most one lifetime task per accepted agent key).
The following local patches were three-way merged from our previous 0.63.3 copy;
the upstream security fixes remain intact.
RSA key import/export now uses OpenSSL, together with the sibling ssh-key copy,
to replace the RSA implementation affected by RUSTSEC-2023-0071. RSA algorithms
and formats remain enabled; see `../ssh-key/SECURITY.md`.
Traditional encrypted RSA PEM now accepts AES-128-CBC and AES-256-CBC through
OpenSSL's legacy EVP_BytesToKey derivation; the AES-256 path no longer panics.
Wrong passwords, malformed IVs and corrupted ciphertext return errors.
Unknown/unsupported channels now reject through their reply handle exactly once.
The old direct failure write also triggered a second rejection when the reply
handle dropped. A real TCP relay regression verifies one refusal followed by a
valid channel-close acknowledgement; the same root cause is fixed on the server.

Microsoft's existing outer relay protocol uses an explicitly anonymous SSH
transport with kex `none`, cipher `none`, and host-key name `none`, inside an
authenticated TLS WebSocket. Modern ssh-key's typed Algorithm cannot represent
the host-key name `none`. Two local changes in `src/negotiation.rs` preserve this
existing protocol:

- A client configured exclusively for kex `none` and cipher `none` writes the
  host-key name `none` in its KEXINIT.
- Only the same exclusive client preferences, an actually selected kex `none`,
  and a peer host-key list containing exactly `none` select keyless relay mode.
  The typed placeholder algorithm is unused because NoneKex skips key exchange.

Default and mixed encryption preferences use the unchanged upstream host-key
and MAC negotiation paths. Normal clients must reject a malicious peer's attempt
to downgrade to `none`. The tunnel client's independent encrypted port session
continues to verify the endpoint's advertised host keys. The WebSocket TLS and
authentication implementation is copied unchanged from the pinned Microsoft SDK.

Tests cover actual relay packets, channel accept/reject/data/close, encrypted
direct TCP/IP transport and host-key rejection, and encrypted-client downgrade
rejection. No unsafe value construction or certificate-validation bypass is used.
