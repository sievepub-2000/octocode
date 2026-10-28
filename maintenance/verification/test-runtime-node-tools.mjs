import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const environment = path.resolve(process.argv[2]);
const base = path.join(environment, 'opensec/node_modules/opensec-intelligence');
const require = createRequire(path.join(base, 'package.json'));
const { z } = require('zod');
const load = file => import(pathToFileURL(path.join(base, 'dist/src', file)));
const { CmdrConfigSchema, McpServerSchema } = await load('config/schema.js');
const validation = await load('llm/validation/tool-call-schema.js');
const { zodToJsonSchema } = await load('tools/registry.js');
const { attemptRepair } = await load('llm/repair/tool-repair.js');
const { webFetchTool } = await load('tools/built-in/web-fetch.js');

assert.deepEqual(CmdrConfigSchema.parse({}), {});
assert.deepEqual(CmdrConfigSchema.parse({ permissions: {} }), {
    permissions: { allowBash: true, allowFileWrite: true, allowNetwork: false }
});
assert.deepEqual(CmdrConfigSchema.parse({ mcp: {} }), { mcp: { servers: [] } });
assert.equal(CmdrConfigSchema.safeParse({ maxConcurrency: 17 }).success, false);
assert.deepEqual(McpServerSchema.parse({ name: 'owned', command: 'node', env: { OWNED: 'yes' } }).env, { OWNED: 'yes' });
assert.equal(McpServerSchema.safeParse({ name: 'owned', transport: 'stdio' }).success, false);
assert.equal(validation.validateToolCallShape({ name: 'owned', arguments: { value: 1 } }).ok, true);
assert.equal(validation.validateToolCallShape({ name: '', arguments: null }).ok, false);
assert.equal(validation.validateToolInput('owned', { count: 'bad' }, z.object({ count: z.number() })).ok, false);
const schema = z.object({ name: z.string(), count: z.number().optional() });
const json = zodToJsonSchema(schema);
assert.equal(json.properties.name.type, 'string');
assert.equal(json.properties.count.type, 'number');
assert.deepEqual(json.required, ['name']);
const repaired = attemptRepair('', [{ name: 'owned', arguments: { count: '42', enabled: 'true' } }], {
    availableTools: ['owned'], toolSchemas: new Map([['owned', z.object({ count: z.number(), enabled: z.boolean() })]])
});
assert.deepEqual(repaired.repaired[0].arguments, { count: 42, enabled: true });
assert.deepEqual(webFetchTool.inputSchema.parse({ url: 'https://example.invalid', headers: { OWNED: 'yes' } }).headers, { OWNED: 'yes' });
let parsed = 0;
assert.equal(z.array(z.any().transform(value => { parsed++; return value; })).max(1).safeParse(Array(1000).fill(1)).success, false);
assert.equal(parsed, 0, 'Reject oversized constrained arrays before visiting elements');
console.log(JSON.stringify({ status: 'PASS', configuration: true, validation: true, jsonSchema: true, repair: true, boundedCollections: true }));
