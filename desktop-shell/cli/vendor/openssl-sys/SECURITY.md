# Native OpenSSL source update

This is the official openssl-sys 0.9.117 crate with its real version and MIT
license preserved. Its FFI declarations already support OpenSSL 4.0. The only
dependency change selects official openssl-src 400.0.2+4.0.3 instead of the older
300 series. OpenSSL 4.0.3 includes the September 2026 security fixes absent from
the previous 3.6.3 source; see the [official OpenSSL 4.0 vulnerabilities page](https://www.openssl-library.org/news/vulnerabilities-4.0/index.html).

On MSVC, build/find_vendored.rs restores OpenSSL's installed static PDB at the
path recorded inside its object files. Upstream openssl-src removes that build
directory after installation, while LLD does not search its native library path
for type-server PDBs. The copy stays inside Cargo's OUT_DIR and preserves debug
information. No linker warning or security advisory is suppressed.

MSVC header expansion uses /EP /nologo directly through cc's discovered compiler
and environment. Its exact input filename status is ordinary build output;
all other stderr lines remain Cargo diagnostics, and the complete original
stderr is retained. Compiler failure remains failure. Positive, C4005 warning,
C1189 error and actual OpenSSL 4.0.3 header probes verify this distinction.
Other compilers retain upstream cc::Build::try_expand behavior.
