---
name: free-claude-code
description: Routes Claude-Code–style coding agents through NVIDIA's free OpenAI-compatible gateway. In OctoCode this is wired as the `nvidia-free` system fallback provider — used when the operator's configured primary provider is unreachable.
source: https://github.com/loonghao/free-claude-code
integration: system-fallback-provider
status: active-provider
registered-provider-id: nvidia-free
---

# free-claude-code

Promoted to **active-provider** in P13. The upstream project routes agent
traffic through NVIDIA's free inference gateway; OctoCode adopts the same
underlying endpoint (`https://integrate.api.nvidia.com/v1`) via the existing
`OpenAiCompatibleProvider`, registered under the provider id
[`nvidia-free`](../../crates/octocode-api/src/lib.rs).

## Why registered

Operators routinely hit provider outages (quota exhaustion, Anthropic 529s,
local model crashes). Without a fallback, OctoCode's turn stalls and the
WebUI stream indicator sits at `running` until the recovery-refresh poll
fires. Adding a **keyless free fallback** converts that failure mode into a
degraded-but-working response.

## Integration shape

* **Not** inserted automatically into every provider's fallback chain —
  that would change long-standing test contracts and silently leak
  traffic to a third-party endpoint.
* **Is** available as a top-level provider id (`nvidia-free`). Operators
  opt in either by:
  1. Setting `OCTOCODE_PROVIDER=nvidia-free` for a given session, or
  2. Configuring their primary provider chain to terminate in
     `nvidia-free` instead of `stub` (follow-up in P14).

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `OCTOCODE_NVIDIA_FREE_BASE_URL` | Override the gateway endpoint | `https://integrate.api.nvidia.com/v1` |
| `OCTOCODE_NVIDIA_FREE_API_KEY` | Optional API key for higher rate limits | (none; keyless free tier) |

## Safety notes

* NVIDIA's gateway is a third-party service. **Never** route traffic
  through `nvidia-free` for sessions that carry secrets, credentials, or
  customer PII. Operators are responsible for redaction at the
  coordinator layer.
* The provider inherits OctoCode's circuit breaker, rate limiter, and
  permission gates — no new tool capability is exposed.
* Fallback is **bounded**: the chain is `[nvidia-free → stub]`, so if
  NVIDIA is unreachable the stub guarantees determinism rather than a
  hang.

## Roadmap

* **P14**: allow operators to append `nvidia-free` to any other
  provider's chain via a single config key (e.g.
  `fallback_chain = ["anthropic", "nvidia-free", "stub"]`).
* **P14**: emit an event-feed entry `provider_fallback_engaged` whenever
  the chain descends past the primary.
* **P15**: ship a health-probe that pings `/v1/models` once per scrape
  interval so `/metrics` can expose `octocode_provider_up{id="nvidia-free"}`.
