# OctoCode maintenance patch

Upstream: dark-light 3.0.0,
https://static.crates.io/crates/dark-light/dark-light-3.0.0.crate
SHA-256: 0f66b71ac6b73812b0bf51cda8dd646a268fbb38623f45b2b7907593c323f745

Migrate the Freedesktop portal adapter to zbus 6. Its wire and name types
replace the discontinued standalone zvariant and zbus_names crates.
The existing async-io feature selects zbus's new default-rt feature; the
portal calls are driven by zbus::block_on and the optional theme-change
stream remains available on its dedicated thread. OwnedVariant replaces
the old OwnedValue. The actual Freedesktop adapter is compiled against
zbus 6 in an isolated API probe; this is not a Linux runtime test.
The historical crate version and upstream licenses are retained.

The published package and its complete upstream tree at
ff54a35edf9ee9665b15a964f5a879f1176c455b contain no full license files.
LICENSE-SPDX-MIT.txt and LICENSE-SPDX-Apache-2.0.txt reproduce the canonical
SPDX texts referenced by the package's explicit MIT/Apache-2.0 declaration;
their source URLs are recorded in each file. Cargo.toml retains the authors.

Windows validates Windows appearance detection only. Linux/BSD portal and
theme-change behavior require a real session bus test before distribution.
