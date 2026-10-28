# Google Harness2

Source: https://github.com/google-research/harness2
Commit: 1cfe254e8d25b15f37048c3730134686abe60335
Version: 0.1.0
License: Apache-2.0 (LICENSE included)

Vendored unmodified task-recursion Python core modules, config.py and package
initializers only. The POSIX schedule/library/judge/selection/report subsystems
are excluded; upstream's complete workflow tests require fcntl and do not pass
on Windows. OctoCode uses the task-level recursion entrypoints directly.
No benchmark datasets, third-party runners, upstream launchers or dependencies.
The original pyproject.toml is retained as upstream config.py's package-root
marker, preventing fallback to the user's cwd and accidental project .env loading.
It is provenance/resource metadata; this partial vendoring is not a pip package.
OctoCode uses its own native API/model/permission workflow through
octocode_harness2.py; it never runs the upstream external CLI launchers.

Upstream metadata declares Python >=3.12,<3.14 and POSIX. OctoCode additionally
tests this selected dependency-free core on its bundled Windows Python 3.14;
this is OctoCode compatibility coverage, not upstream platform support.
