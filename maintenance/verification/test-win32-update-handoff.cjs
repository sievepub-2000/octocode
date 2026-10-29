const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const desktop = path.resolve(__dirname, '../../desktop-shell');
const ts = require(path.join(desktop, 'node_modules/typescript'));
const input = fs.readFileSync(path.join(desktop, 'src/vs/platform/update/electron-main/updateService.win32.ts'), 'utf8');
const ast = ts.createSourceFile('update.ts', input, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'Win32UpdateService');
const method = service.members.find(node => node.name?.getText(ast) === 'doQuitAndInstall');
const code = ts.transpileModule('class Fixture {' + method.getText(ast) + '} globalThis.Fixture = Fixture;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;
let calls = [], detached = 0, errors = 0, onError;
const context = { path: path.win32, process: { env: { SystemRoot: 'C:\\Windows' } }, StateType: { Ready: 'ready', Restarting: 'restarting' },
  shell: { openPath() { throw new Error('Electron has already shut down'); } },
  spawn(...args) { calls.push(args); return { on(event, handler) { assert.equal(event, 'error'); onError = handler; }, unref() { detached++; } }; }
};
vm.runInNewContext(code, context, { timeout: 1000 });
const fixture = new context.Fixture();
Object.assign(fixture, { state: { type: 'ready' }, availableUpdate: { packagePath: 'E:/Program Files/octocode/data/tmp/verified.exe' },
  productService: { target: 'system' }, logService: { trace() {}, error() { errors++; } } });
fixture.doQuitAndInstall();
fixture.doQuitAndInstall();
assert.equal(calls.length, 1, 'Repeated shutdown callbacks must launch only once');
assert.equal(calls[0][0], 'C:\\Windows\\explorer.exe');
assert.equal(calls[0][1].length, 1);
assert.equal(calls[0][1][0], fixture.availableUpdate.packagePath);
assert.equal(calls[0][2].detached, true);
assert.equal(calls[0][2].stdio, 'ignore');
assert.equal(detached, 1);
onError(new Error('owned failure fixture'));
assert.equal(errors, 1);
console.log('PASS: handoff survives Electron shutdown, preserves spaced path, launches once, reports errors');
