# MCP stdio recovery regression candidate

36 deterministic integration cases use the repository's installed TypeScript, actual McpHub source, actual MCP SDK Client/StdioClientTransport/result schemas and harmless new Node fixtures. Tests adapt VS Code, provider/cache, initialization, provisioning and explicit scheduling gates. The minimal server is handwritten JSON-RPC. Cases 16/19 also execute actual toolHub; cases 34/35 extract the complete actual updateSettings case. No model, Native permissions, GUI, credentials, network or existing MCP processes are used.

Run on Windows with a fresh owned output directory. Existing SDK and TypeScript in Core node_modules are required. No package or lock modification is needed. The final worker run used these exact portable files.

```powershell
$env:OCTOCODE_STDIO_TEST_ROOT = '<fresh owned output directory>'
node .\src\services\mcp\__tests__\stdio-recovery\recovery-tests.cjs
```

When testing a separate source candidate, set `OCTOCODE_STDIO_TEST_CORE` to the Core checkout containing the installed dependencies and pass the candidate McpHub.ts path and an output child directory as the first two arguments. The sibling candidate webviewMessageHandler.ts is used when present. An optional third argument filters case names.

The declared output root contains the copied owned fixture, exact compiled class snapshots, command/stdout/stderr/result records, fixture raw stdin/stdout and actual child close evidence. Every case closes owned handles in finally. The fixture may only run the declared Node script with owned files/cwd. No PID-only cleanup is used. Windows path-equivalence case 36 intentionally asserts the actual Windows platform; no Linux/macOS acceptance is implied.

Ordinary connection close recovers only before a new call. A request that executed and lost its response is rejected and never replayed. Negative cases verify absence of the forbidden marker on physical fixture stdin, not just a stub request count. Explicit stale callbacks and post-reconnect scheduling adapters are named separately in REPORT.md; they are not naturally observed OS events.

Do not claim production model write, real VS Code persistence, live task permission or installed-product acceptance from this suite. Do not include OAuth loops or the Native diagnostic HOLD in this command.
