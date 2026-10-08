// A deliberately harmless JSON-RPC fixture; no model, networking, user config or other executables.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const [rootArg, logArg, label, gateArg] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
function owned(file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Fixture path outside owner');
  return resolved;
}
const log = owned(logArg);
const gate = gateArg ? owned(gateArg) : undefined;
function record(event, data = {}) {
  fs.appendFileSync(log, JSON.stringify({event, pid: process.pid, label, utc: new Date().toISOString(), ...data}) + '\n');
}
function reply(id, result) {
  const raw = JSON.stringify({jsonrpc: '2.0', id, result}) + '\n';
  record('stdout', {raw});
  process.stdout.write(raw);
}
async function waitGate() {
  if (!gate) return;
  record('tools-list-gated');
  const start = Date.now();
  while (!fs.existsSync(gate)) {
    if (Date.now() - start > 5000) throw new Error('Owned gate deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
record('birth', {executable: process.execPath, fixture: __filename, cwd: process.cwd()});
const input = readline.createInterface({input: process.stdin});
input.on('line', async raw => {
  record('stdin', {raw: raw + '\n'});
  try {
    const message = JSON.parse(raw);
    if (message.id === undefined) return;
    switch (message.method) {
      case 'initialize':
        reply(message.id, {protocolVersion: message.params.protocolVersion,
          capabilities: {tools: {}, resources: {}}, serverInfo: {name: 'owned-stdio-fixture', version: '1.0.0'}});
        break;
      case 'tools/list':
        await waitGate();
        if (label.startsWith('fail-list')) {
          const raw = JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Owned list failure'}})+'\n';
          record('stdout',{raw});process.stdout.write(raw);break;
        }
        reply(message.id, {tools: ['probe', 'close_after_execute'].map(name=>({name,
          annotations: {readOnlyHint: true}, inputSchema: {type:'object', properties:{marker:{type:'string'}}}}))});
        break;
      case 'resources/list': reply(message.id, {resources: []}); break;
      case 'resources/templates/list': reply(message.id, {resourceTemplates: []}); break;
      case 'tools/call':
        record('executed', {id:message.id, tool:message.params.name, marker:message.params.arguments?.marker});
        if (message.params.name === 'close_after_execute') {
          record('exit-without-reply');
          process.exit(0);
        }
        reply(message.id, {content: [{type:'text', text:JSON.stringify({label, pid:process.pid, marker:message.params.arguments?.marker})}]});
        break;
      default:
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, error:{code:-32601, message:'Fixture method not found'}})+'\n');
    }
  } catch (error) {
    record('fixture-error', {message: error.message});
    process.exitCode = 1;
    input.close();
  }
});
input.on('close', () => {record('stdin-ended'); process.exit(process.exitCode ?? 0);});
process.on('exit', code => record('exit', {code}));
