---
name: claude-design
description: Reference library of Anthropic-style product-design patterns for chat UIs — density, latency affordances, tool-call disclosure, streaming indicators.
source: https://github.com/claude-design
integration: reference-only
status: descriptor-only
---

# claude-design

Descriptor-only registration (P9 batch).

## Why registered
- P8 fixed the "AI 正在响应" indicator mis-firing. That fix is one data point of a larger design language (when to show latency, when to disclose tool calls, how to label thinking vs. streaming).
- Use this skill's patterns as the cross-check when evolving `ui-shell/app.js` status-bar / tool-call rendering.

## Integration plan (deferred)
- No runtime code. Acts as a **reviewer checklist** consulted by the WebUI QA skill (`playwright-webui-qa`).

## Checklist excerpt
- [ ] Streaming label switches **only** when there are no tokens for ≥ 1200ms.
- [ ] Tool call is disclosed inline, not hidden behind a modal.
- [ ] Error states keep the prior assistant message visible.
