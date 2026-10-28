# Windows build driver fixes, OpenSSL 4.0.3

Only the Rust build driver of official openssl-src 400.0.2+4.0.3 is maintained
here. The real package name/version, original license files and provenance are
preserved. The unchanged official registry package with the same real version
remains a dependency, under a Rust dependency alias, and supplies all C assets
through its public source_dir(). Both source identities remain in Cargo.lock
and vulnerability/license coverage. No C code is copied, renamed or modified.

The local driver corrects the upstream Windows SYS$MANAGER:[OPENSSL] directory,
which NMake expands into an invalid C string, producing C4129 and an incorrect
runtime configuration path. It now honors an explicit openssl_dir() on Windows
and uses C:/Program Files/Common Files/SSL by default. Non-Windows defaults are
unchanged. install_dev only installs under Cargo OUT_DIR, not that config path.

MSVC Configure now receives CFLAGS, HOST/TARGET_CFLAGS and target-specific
CFLAGS in cc's precedence order, preserving existing flags and adding /utf-8
once. This fixes C4819 for OpenSSL's UTF-8 C sources. No warning is disabled.
The official registry C release is asserted to match the driver's real version.
The upstream private, unused Artifacts.bin_dir field is removed; the public
artifact API and installed outputs are unchanged. No dead-code lint is disabled.
