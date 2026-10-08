# MCP manager/provider lifetime regression candidate

18 new integration cases. Complete Manager and Hub are transpiled from selected Source; exact provider constructor MCP expression and dispose/clear/install lifecycle bodies are extracted into a host shell. Actual installed SDK Client/StdioClientTransport and harmless owned Node stdin/stdout are real. VS Code/provider/storage/other services and deliberate scheduling/rejections are adapters. No GUI/model/Native/credentials/network/existing MCP process is used.

Run with a fresh explicitly owned output directory and the already installed Core dependencies:

```powershell
$env:OCTOCODE_STDIO_TEST_ROOT = '<fresh owned output directory>'
node .\src\services\mcp\__tests__\manager-lifetime\lifetime-tests.cjs
```

For a separate candidate, set OCTOCODE_STDIO_TEST_CORE to the dependency Core checkout and pass the candidate source root (containing the three source files) and a child output directory as the first two arguments. No package or lock update is required. Exact portable artifacts were executed in this worker.

Tests cover normal two-provider ownership, concurrent acquisition, repeat gets, last-dispose/reopen, primary weak-reference handoff, pending constructor/marketplace cancellation, metadata failure, overlapping cleanup, anonymous-reference compatibility, current notification fanout, new-generation isolation and failure-safe provider teardown. The original no-argument Hub references and synchronous void unregister API are controls.

Every owned child has actual start/close records and raw fixture stdin/stdout. Every case finally closes exact handles. Controlled close/metadata barriers and service failures are explicit, not invented OS failures. There is no claim of real UI event delivery, forced GC, different-workspace behavior, actual VS Code durability, model write, other-platform or production acceptance. Do not run old36/148 or Native diagnostic HOLD as part of this suite.
