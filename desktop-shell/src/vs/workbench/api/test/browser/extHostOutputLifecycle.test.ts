/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { LogLevel, NullLogger } from '../../../../platform/log/common/log.js';
import { ExtHostOutputService } from '../../common/extHostOutput.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('Extension log channel disposal', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	test('late log calls retain their severity and arguments without reopening a closed channel', async () => {
		const calls: { level: string; args: unknown[] }[] = [];
		const logger = store.add(new NullLogger());
		for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
			logger[level] = (...args: unknown[]) => { calls.push({ level, args }); };
		}
		const service = Object.assign(Object.create(ExtHostOutputService.prototype), { logService: logger }) as ExtHostOutputService;
		const disposables = store.add(new DisposableStore());
		const channel = { logLevel: LogLevel.Info, onDidChangeLogLevel: Event.None, dispose() { }, info() { throw new Error('disposed channel reused'); } };
		const output = service['createExtHostLogOutputChannel']('owned log', LogLevel.Info, Promise.resolve(channel) as never, disposables);
		await Promise.resolve();
		disposables.dispose();
		const failure = new Error('retained diagnostic');
		for (const level of ['trace', 'debug', 'info', 'warn'] as const) { output[level]('late message', 17); }
		output.error(failure, 23);
		assert.deepStrictEqual(calls.map(call => call.level), ['trace', 'debug', 'info', 'warn', 'error']);
		assert.strictEqual(calls[4].args[0], failure);
		assert.strictEqual(calls[4].args[1], 23);
		assert.throws(() => output.append('closed ordinary output'), /Channel has been closed/);
	});
});
