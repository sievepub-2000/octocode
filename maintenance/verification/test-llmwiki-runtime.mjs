import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const environment = path.resolve(process.argv[2]);
const base = path.join(environment, 'tools/mcp/llmwiki');
const require = createRequire(path.join(base, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const core = path.join(base, 'node_modules/@llmwiki/core');
const { initWiki } = await import(pathToFileURL(path.join(core, 'dist/index.js')));
const test = path.resolve('E:/Program Files/octocode/test');
await fs.mkdir(test, { recursive: true });
const fixture = await fs.mkdtemp(path.join(test, 'llmwiki-runtime-'));
assert.equal(path.dirname(fixture), test);
let client;
async function connect() {
    client = new Client({ name: 'octocode-owned-acceptance', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
        command: path.join(environment, 'node/node.exe'),
        args: [path.join(core, 'dist/mcp/bin.js'), path.join(fixture, '.wiki')],
        cwd: fixture, stderr: 'pipe'
    }));
}
async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return JSON.stringify(result);
}
try {
    await initWiki(fixture);
    await connect();
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'wiki_write_page'));
    const pagePath = 'concepts/owned-acceptance.md';
    await call('wiki_write_page', { pagePath, title: 'Owned acceptance', type: 'concept', body: 'OWNED_CREATE_OK' });
    assert((await call('wiki_read_page', { path: pagePath })).includes('OWNED_CREATE_OK'));
    await call('wiki_update_page', { pagePath, bodyReplace: 'OWNED_UPDATE_OK' });
    await client.close();
    await connect();
    assert((await call('wiki_read_page', { path: pagePath })).includes('OWNED_UPDATE_OK'));
    const denied = await client.callTool({ name: 'wiki_read_page', arguments: { path: '../../outside' } });
    assert.equal(denied.isError, true);
    await fs.unlink(path.join(fixture, '.wiki/wiki', pagePath));
    const deleted = await client.callTool({ name: 'wiki_read_page', arguments: { path: pagePath } });
    assert.equal(deleted.isError, true);
    console.log(JSON.stringify({ status: 'PASS', tools: tools.tools.length, createReadUpdate: true,
        restartReadback: true, traversalRejected: true, ownedFileDeletionReadback: true }));
} finally {
    await client?.close();
    assert.equal(path.dirname(path.resolve(fixture)), test);
    await fs.rm(fixture, { recursive: true, force: true });
}
