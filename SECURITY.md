# Security Policy

Octocode is a local development tool. The Octocode project does not
operate any backend service, so the practical attack surface is the
binary, the WebUI shell, and the documented provider transports. We
take security reports seriously regardless.

## Supported versions

Only the most recent tagged release on the default branch
(`master`) of <https://github.com/sievepub-2000/octocode> is supported
with security fixes. Older tags receive fixes only when a backport is
specifically requested in the report.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, **not** through the
public issue tracker, to either of the following addresses:

- `sievepub@outlook.com`
- `3925447879@qq.com`

If you prefer GitHub's private vulnerability reporting flow, open a
private advisory at
<https://github.com/sievepub-2000/octocode/security/advisories/new>.

In the report, please include:

1. A description of the issue and the affected component
   (`octocode-runtime`, `octocode-api`, the WebUI, a script under
   `scripts/`, etc.).
2. Steps to reproduce, ideally a minimal repro.
3. Affected platforms (Windows / macOS / Linux) and the Octocode
   version (`octocode-cli --version`).
4. Whether the issue can leak credentials, allow arbitrary code
   execution, or escalate the configured permission mode.

## Triage and response

We aim to acknowledge new reports within five business days and to
publish a fix or mitigation within a reasonable timeframe based on
severity. The reporter is credited in the release notes unless they
request anonymity.

## Scope

In scope:

- Sandbox bypass (a tool execution that violates the active
  permission mode).
- Credential exposure in logs, snapshot exports, or transport
  payloads.
- Injection issues in provider transports, MCP discovery, or the
  WebUI Markdown renderer.
- Local privilege escalation via the platform shell wrapper.
- Insecure defaults that ship in the binary.

Out of scope:

- Issues that depend on attacker-supplied workspace contents that the
  user has explicitly granted `workspace-write` or
  `danger-full-access` to. The permission system intentionally trusts
  these modes.
- Bugs in third-party provider services.
- Denial of service via excessive request volume against an upstream
  provider configured by the user.
