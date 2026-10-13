"""Import reviewed operational facts, then verify update/read-back via the real MCP."""
if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import asyncio, json, pathlib
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

root = pathlib.Path(r'D:\gpt-workspace\octocode')
app = pathlib.Path(r'D:\Program Files\OctoCode')
body = '''# OctoCode operations — 2026-09-21

The sole executable installation is D:\\Program Files\\OctoCode.
Machine 3 project sources and physical runtime belong to D:\\gpt-workspace\\octocode.
Runtime data, workspace and environments are exposed through native directory junctions.
The octocode.workspace.path setting is the sole workspace authority; a user value wins,
otherwise the default is the installation's workspace directory. Never select another
workspace silently after an error.

Machine 4 serves one qwen38-flash-next model under the zillafan oMLX App.
Machine 3 uses the wired endpoint http://2.2.2.2:8000/v1.
MTP is enabled with depth 3 and temperature 0.85. Metal optimized attention is automatic.
DFlash and expert offload must not be enabled together with the current MTP configuration.
Keep API credentials in encrypted client storage and the restricted server settings.
Never paste credentials into repository files, reports, or shell commands.

Use source/octocode-build.ps1 for the full release pipeline. Build from committed source;
versioned bundled skills are authoritative. Verify packaged host/harness hashes.
Use the native Windows uninstaller and verify registration, shortcuts and PATH removal.
The current-config snapshot uses SQLite backup and requires an actual restore check.

oMLX Dev updates run as the user LaunchAgent app.omlx.dev-updater. It checks signatures,
release digest and override compatibility before replacing the App. Changed upstream
modules require patch review; do not disable hash checks. Check dev-update-status.json.
An incompatible future Dev release is held while the current service remains usable.

Qwen nonconvergence during alibaba/open-code-review remains assigned to Claude.
Do not treat short successful inference or unit tests as proof of full review convergence.
'''

async def main(timeout=60):
    params = StdioServerParameters(command=str(app / 'environments/node/node.exe'), args=[str(app / 'environments/llmwiki/node_modules/@llmwiki/core/dist/mcp/bin.js'), str(root / 'runtime/workspace/.wiki')])
    async with asyncio.timeout(timeout):
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                page = 'concepts/octocode-operations.md'
                result = await session.call_tool('wiki_write_page', {'pagePath': page, 'title': 'OctoCode operational source of truth', 'type': 'concept', 'body': body})
                assert not result.isError
                result = await session.call_tool('wiki_read_page', {'path': page})
                assert not result.isError
                text = '\n'.join(getattr(c, 'text', '') for c in result.content)
                assert 'app.omlx.dev-updater' in text and 'octocode.workspace.path' in text
                print(json.dumps({'page': page, 'readBack': 'PASS', 'secretsIncluded': False}))

if __name__ == '__main__':
    asyncio.run(main())
