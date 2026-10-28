import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { InstantiationService } from '../../../out/vs/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../out/vs/platform/instantiation/common/serviceCollection.js';
import { createDecorator } from '../../../out/vs/platform/instantiation/common/instantiation.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../../../src/vs/workbench/contrib/update/browser/update.contribution.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('update.contribution.ts', source, ts.ScriptTarget.Latest, true);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const id of ['update.useGitHubToken', 'update.signInGitHub']) {
  test(`${id} captures services before asynchronous authentication`, async () => {
    let body;
    const visit = node => {
      if (ts.isClassExpression(node) && node.members.some(member => ts.isConstructorDeclaration(member) && member.getText(parsed).includes(`'${id}'`))) {
        body = node.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(parsed) === 'run').body.getText(parsed).slice(1, -1);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert(body, 'Actual registered action method must be found');
    const calls = [];
    const authId = createDecorator(`test-auth-${id}`);
    const updateId = createDecorator(`test-update-${id}`);
    const service = new InstantiationService(new ServiceCollection(
      [authId, { createSession: async (...args) => { calls.push(['login', ...args]); await Promise.resolve(); } }],
      [updateId, { checkForUpdates: async explicit => { calls.push(['check', explicit]); } }]
    ));
    try {
      const run = new AsyncFunction('accessor', 'IAuthenticationService', 'IUpdateService', body);
      await service.invokeFunction(accessor => run(accessor, authId, updateId));
      assert.deepEqual(calls[1], ['check', true]);
      assert.equal(calls[0][3].useToken, id === 'update.useGitHubToken' ? true : undefined);
    } finally { service.dispose(); }
  });
}
