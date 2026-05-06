---
name: privacy-filter
description: "Use when: filtering prompts, logs, screenshots, transcripts, documents, or tool outputs for secrets, credentials, PII, private URLs, tokens, keys, or sensitive personal data before sharing with another agent or external service."
---

# Privacy Filter

Use the official OpenAI Privacy Filter repository as source context for PII detection and masking.

Local source cache:

- `C:/Users/周浩/.codex/vendor_imports/openai/privacy-filter`

Privacy Filter is a bidirectional token-classification model and CLI for detecting and masking PII in text. Use this skill as the local operating policy around that official source.

Before sending content to another agent, Codex, browser automation, or an external service:

1. Redact credentials: API keys, access tokens, cookies, SSH private keys, passwords.
2. Redact personal identifiers unless required: phone, email, national ID, address, private account names.
3. Replace private paths and URLs with stable placeholders when exact values are not needed.
4. Preserve technical structure so debugging remains possible.
5. State what was redacted at a high level, without revealing the secret.

Use placeholders such as `<API_KEY_REDACTED>`, `<PRIVATE_PATH>`, `<PRIVATE_URL>`, and `<USER_IDENTIFIER>`.
