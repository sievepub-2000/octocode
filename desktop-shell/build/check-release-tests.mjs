// Run focused desktop regression tests from current source using the existing Node runner.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Mocha from 'mocha';
import ts from 'typescript';

const tests = [
  'vs/platform/update/test/electron-main/win32UpdatePackage.test',
  'vs/platform/update/test/electron-main/abstractUpdateService.test',
  'vs/workbench/api/test/browser/extHostDecorations.test',
];
const files = [...tests,
  'vs/platform/update/electron-main/win32UpdatePackage',
  'vs/platform/update/electron-main/abstractUpdateService',
  'vs/workbench/api/common/extHostDecorations',
];
for (const file of files) {
  const output = path.join('out', file + '.js');
  const result = ts.transpileModule(fs.readFileSync(path.join('src', file + '.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, experimentalDecorators: true, useDefineForClassFields: false },
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error('Transpile failed: ' + file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.outputText);
}
// The upstream runner assumes remote/.npmrc pins Electron's Node version;
// this product instead runs the pinned bundled Node toolchain.
globalThis._VSCODE_PRODUCT_JSON = JSON.parse(fs.readFileSync('product.json', 'utf8'));
globalThis._VSCODE_PACKAGE_JSON = JSON.parse(fs.readFileSync('package.json', 'utf8'));
globalThis._VSCODE_FILE_ROOT = pathToFileURL(path.resolve('out')).href;
const mocha = new Mocha({ ui: 'tdd', timeout: 10000 });
for (const test of tests) mocha.addFile(path.join('out', test + '.js'));
await mocha.loadFilesAsync();
process.exitCode = await new Promise(resolve => mocha.run(resolve));
