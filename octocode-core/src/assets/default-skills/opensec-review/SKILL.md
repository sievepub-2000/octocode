---
name: opensec-review
description: Run the bundled OpenSec Intelligence CLI for deterministic security scans when a user requests a security review, vulnerability scan, or secure-code audit.
---

# OpenSec Review

Use the bundled CLI; do not duplicate its scanner in OctoCode core.

- Run a local, non-mutating scan with: `$env:OPENSEC_OLLAMA_URL='http://127.0.0.1:9'; & (Join-Path $env:OCTOCODE_ENVIRONMENTS 'opensec\node_modules\.bin\opensec.cmd') scan <absolute-path> --quick --output-format json`.
- Report file, line, rule, severity, confidence, and verified remediation.
- Treat results as one review signal and still run the project's native tests.
- Never use `fix`, `prove`, or a cloud/model-backed mode unless the user explicitly authorizes mutation or external transmission.
