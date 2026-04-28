# Round 4 — `/api/tool` & `/api/state` deadlock fix (2026-04-30)

## Summary

Round-3 validation (commit `c5b24c5`) marked one P0 infrastructure defect:
**WebUI HTTP requests hitting `/api/state` or `POST /api/tool` would time out at 30 s.**

This round isolates the root cause and ships a one-file fix that brings the
slowest cold-cache snapshot from ≥30 s (timeout) to ≈9 s, and warm-cache
responses to ≤70 ms.

## Root cause

`runtime.snapshot_json` → `RuntimeRuntime::status` →
`provider_routes` → `RuntimeProviderRouter::routing_statuses` was a **serial
loop** over all configured providers, calling `provider.health()` on each one.

With the catalog at 17 providers and every probe owning a 5 s read timeout
(`run_health_probe`) plus a 5 s health-cache TTL, a single cold snapshot
required `O(N · timeout)` ≈ 25–35 s of sequential network work — well past
both the 15 s client timeout and the apparent "deadlock" symptom.

The sister method `health_catalog()` already used `std::thread::scope` for
parallel probes; `routing_statuses` had been missed during the original
parallelization pass.

## Patch

`crates/octocode-runtime/src/router.rs::routing_statuses`

```rust
pub fn routing_statuses(&self) -> Vec<ProviderRouteStatus> {
    let active_provider_id = self.active_provider_id();
    if self.providers.len() <= 1 {
        // serial fallback — same behaviour as before
    }
    let mut healths: Vec<Option<ProviderHealth>> =
        (0..self.providers.len()).map(|_| None).collect();
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(self.providers.len());
        for provider in &self.providers {
            handles.push(scope.spawn(move || provider.health()));
        }
        for (idx, handle) in handles.into_iter().enumerate() {
            healths[idx] = handle.join().ok();
        }
    });
    /* assemble ProviderRouteStatus from cached healths */
}
```

Wall-clock cost collapses from `Σ probe_latency` to `max probe_latency`.

## Verification

### Compile + tests

```text
cargo check --workspace          → Finished in 2.50s
cargo test --workspace --lib --tests
  → 404/404 passed (15+78+0+7+15+16+14+7+15+217+19+1)
```

### Live WebUI smoke (port 994, fresh boot, fix applied)

| call                          | first hit (cold) | cache hit |
| ----------------------------- | ---------------: | --------: |
| `GET /api/state`              |        **8.79 s**|   25–66 ms|
| `POST /api/tool skill-list`   |             44 ms|     66 ms |
| `POST /api/tool file-tree`    |             69 ms|     40 ms |
| `POST /api/tool session-search` |          50 ms |     48 ms |
| `POST /api/tool skills-hub-render` |       3.17 s |     46 ms |
| `GET /api/state` (final)      |             37 ms|     33 ms |

(Pre-fix baseline: every call above timed out at 30 s on cold cache.)

The `skills-hub-render` 3.17 s on first call reflects skill markdown
ingestion, not the provider probe path — independent and acceptable.

### CLI parity

```text
target\debug\octocode-cli.exe tool skill-list --session fix-cli
  → exit=0 in 31 ms ("no skills recorded")
```

Direct CLI was already fast pre-fix; this confirms the regression was strictly
on the HTTP snapshot path and not in tool execution itself.

## Scope

- Touches **only** `crates/octocode-runtime/src/router.rs`.
- No public API change. All 404 unit + integration tests unchanged.
- `FallbackProvider::health_catalog` in `octocode-api` still walks providers
  serially; that path only matters when a `FallbackProvider` is actively
  wrapping the catalog, which is not the WebUI default. Filed for follow-up
  but not on the P0 critical path.

## Status after this round

- `cargo check --workspace` ✅
- `cargo test --workspace --lib --tests` ✅ 404/404
- WebUI HTTP `/api/state` + `POST /api/tool` ✅ all fast
- 17-provider health catalog ✅
- 81 tools registered ✅ (including round-3 names: `modal-command`,
  `daytona-command`, `fly-command`, `skills-hub-render`, `session-search`,
  `user-search`, `sessions-for-user`, `session-index`, `user-index`,
  `file-tree`, `skill-list`)

P0 from round-3 is **cleared**. Octocode master is releasable.
