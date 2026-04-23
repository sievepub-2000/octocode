---
name: cli-proxy-api-bridge
description: Adapter layer that fronts heterogeneous model providers behind a single OpenAI-compatible HTTP/1.1 surface so OctoCode's tool-call protocol is real function-calling, not plain-text "<|tool_call|>" markers.
source: https://github.com/luispater/CLIProxyAPI
integration: sidecar-process
---

# cli-proxy-api-bridge

**Problem this skill solves**: some models (notably Chinese OSS chat models and a few local llama.cpp builds) respond with a *text* marker like `<|tool_call|>tool-web-search(query="…")<tool_call|>` instead of emitting a structured `tool_calls` block. OctoCode then treats the reply as prose and the tool never runs.

The fix is a **protocol-translating proxy** in front of the upstream model: it parses the model's native tool-call syntax (whether OpenAI function-calling JSON, Anthropic `tool_use` blocks, Qwen `<|tool_call|>` markers, DeepSeek `<|tool_calls_begin|>…`, Llama-3 `<|python_tag|>`, etc.) and re-emits a canonical OpenAI-compatible `tool_calls` payload. OctoCode's runtime then dispatches the call for real.

## When to use

- Any model whose provider page says "supports tool calling" but whose replies still arrive as text.
- Any local model served via llama.cpp / Ollama where function-calling is opt-in.
- Regression: if a user reports `<|tool_call|>` literally appearing in the chat output.

## Requirements

- `cli-proxy-api` binary (or container) running as a sidecar on a localhost port.
- OctoCode provider `base_url` pointed at the proxy; upstream real endpoint configured inside the proxy.

## Minimal invocation

1. Start the proxy (example for Qwen-style markers):
   ```powershell
   cli-proxy-api --listen 127.0.0.1:11434 --upstream https://api.deepseek.com --translate qwen-tool-call
   ```
2. In OctoCode `config-show` → set the target provider's `base_url` to `http://127.0.0.1:11434/v1`.
3. Re-run the failing prompt. Tool calls now appear as structured `tool_calls` in the SSE stream and are dispatched by the runtime.

## Canonical output OctoCode expects

The proxy MUST translate every upstream dialect into this shape inside a streamed `delta`:

```json
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_abc",
        "type": "function",
        "function": { "name": "web.search", "arguments": "{\"query\":\"…\"}" }
      }]
    }
  }]
}
```

## Integration notes

- This descriptor is the **contract**. The actual proxy is external; OctoCode does not vendor it.
- The `octocode-runtime` tool dispatcher already consumes the canonical shape above; the bug reported by the user is specifically that **some providers skip the translation layer**. This skill documents the fix path until a native Rust translator lands in `octocode-api` (tracked as P10 milestone in the evaluation report).
- Until the proxy is in place, the runtime has a **defensive text-scanner** that can detect `<|tool_call|>` markers and surface them as *blocked* tool attempts rather than silent no-ops — see `crates/octocode-runtime/src/tools.rs` for the scanner's unit tests.
