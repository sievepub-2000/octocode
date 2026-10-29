import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const input = path.resolve(process.argv[2]);
const runtime = fs.existsSync(path.join(input, 'tools/mcp/llmwiki/package.json'))
  ? path.join(input, 'tools/mcp/llmwiki') : input;
const require = createRequire(path.join(runtime, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const { initWiki } = await import(pathToFileURL(path.join(runtime, 'node_modules/@llmwiki/core/dist/index.js')));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-llmwiki-security-'));
let client;
async function connect() {
  client = new Client({ name: 'owned-runtime-acceptance', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(runtime, 'node_modules/@llmwiki/core/dist/mcp/bin.js'), path.join(fixture, '.wiki')], stderr: 'pipe' }));
}
try {
  await initWiki(fixture);
  await connect();
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'wiki_write_page'));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
    assert(!result.isError, JSON.stringify(result));
    return result.content.map(item => item.text || '').join('\n');
  };
  await call('wiki_write_page', { pagePath: 'concepts/owned.md', title: 'Owned fixture', type: 'concept', body: 'owned-marker-first' });
  assert((await call('wiki_read_page', { path: 'concepts/owned.md' })).includes('owned-marker-first'));
  await call('wiki_update_page', { pagePath: 'concepts/owned.md', bodyReplace: 'owned-marker-updated' });
  await client.close();
  await connect();
  const updated = await call('wiki_read_page', { path: 'concepts/owned.md' });
  assert(updated.includes('owned-marker-updated') && !updated.includes('owned-marker-first'));
  assert((await call('wiki_list_pages', {})).includes('owned.md'));
  const denied = await client.callTool({ name: 'wiki_read_page', arguments: { path: '../../outside' } });
  assert.equal(denied.isError, true);
  fs.unlinkSync(path.join(fixture, '.wiki/wiki/concepts/owned.md'));
  const deleted = await client.callTool({ name: 'wiki_read_page', arguments: { path: 'concepts/owned.md' } });
  assert.equal(deleted.isError, true);
  console.log(JSON.stringify({ status: 'PASS', realStdioMcp: true, tools: tools.tools.length,
    createReadUpdateReadList: true, restartReadback: true, traversalRejected: true, ownedFileDeletionReadback: true }));
} finally {
  await client?.close();
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith('octocode-llmwiki-security-'));
  fs.rmSync(fixture, { recursive: true });
}
