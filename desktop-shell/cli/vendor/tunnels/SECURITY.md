# Local Rust SSH dependency migration

This MIT-licensed SDK is copied from Microsoft dev-tunnels commit
`64048c1409ff56cb958b879de7ea069ec71edc8b` without changing its package version.
The local changes migrate its SSH integration from the Microsoft russh 0.37.1
fork to the upstream russh 0.64.1 release (including both October authentication
algorithm and agent lifetime-constraint fixes) and
remove russh-keys 0.37.1.
The upstream SDK still requires the obsolete Microsoft fork, so this local copy
is necessary until upstream completes the same API migration.

The relay-specific `client-ssh-session-stream` channel remains supported through
upstream's unknown-server-channel acceptance and confirmed-channel callbacks.
Host keys continue to use canonical SSH public key encoding, and clients continue
to require the endpoint's advertised host public keys. Tests verify both protocol
compatibility and security boundaries.

The supported Ring backend is selected explicitly for the Windows toolchain;
the default AWS-LC backend requires NASM, which is absent from this installation.
RSA authentication and SSH compression remain enabled.

The optional instrumentation API uses opentelemetry 0.32 without its obsolete
0.20 API/SDK dependency chain. This SDK only uses the tracer API; applications
still provide a tracer implementation through the global provider.
The RSA implementation is supplied by the sibling ssh-key OpenSSL backend;
RSA key generation, endpoint fingerprints, signing, verification and key formats
remain supported. The regression tests now use real loopback TCP sockets.
