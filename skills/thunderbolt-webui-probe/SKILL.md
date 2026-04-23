---
name: thunderbolt-webui-probe
description: Protocol-level probe that hits a WebUI over HTTP/SSE/WebSocket and records timing + payload for deterministic health checks.
source: https://github.com/ThunderboltBrowser/Thunderbolt
integration: descriptor
---

# thunderbolt-webui-probe

Use this skill to generate a **non-render** probe of the OctoCode WebUI when a full browser is not available. It verifies protocol-level behavior (SSE frames, WebSocket handshake, `/api/state`) rather than rendered pixels.

## When to use

- Fast CI gate before booting a real browser.
- Diagnosing whether an "AI is responding" indicator mismatch is a backend phase bug vs a frontend render bug.
- Capturing the first N SSE tokens to decide whether the stream is alive.

## Minimal invocation

```powershell
curl.exe -N -H "X-Auth-Token: $env:OCTOCODE_AUTH" "http://127.0.0.1:10038/api/stream?session=<id>&text=ping" | Select-Object -First 20
```

## Integration notes

- Intentionally does **not** require any JS runtime.
- Output is line-delimited SSE and can be compared against a golden file per release.
