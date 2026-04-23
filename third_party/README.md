# third_party — vendored integration drop-points

This directory holds **pinned** external integrations that the workspace
references but does **not** redistribute directly. Each subdirectory has:

* `README.md` with the upstream source URL and the pinned ref.
* An optional `INTEGRATION.md` describing how OctoCode uses it.
* A `.gitignore` that excludes the cloned tree from this repo.

Operators bootstrap the tree with:

```powershell
pwsh scripts/fetch-integrations.ps1
```

which performs a `git clone --depth=1` of each pinned ref into the
corresponding subdirectory, or a `git -C <dir> fetch --depth=1 origin
<ref>` if it already exists. The script is **idempotent** and never
runs any of the pulled code.

## Security contract

* Nothing under `third_party/<name>/` is compiled into the OctoCode
  binaries. If a future phase wants to consume one of them, it must go
  through the normal Cargo dependency path with explicit review.
* The fetch script only supports HTTPS sources; refs are pinned by
  commit SHA or tag.
* Downloaded trees are listed in `.gitignore` so we never accidentally
  vendor a `node_modules/` or Go build cache into the OctoCode repo.
