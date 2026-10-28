/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
import { strictEqual } from 'assert';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService } from '../../browser/terminal.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import '../../../octocode/browser/octoCodeShell.contribution.js';

suite('OctoCode native terminal output', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const command = () => CommandsRegistry.getCommand('workbench.action.octocode.writeRuntimeTerminal')!.handler;

	test('writes only to the owning display and never executes output', async () => {
		let output = '';
		const owner = { title: 'chat-a', xtermReadyPromise: Promise.resolve({ raw: { write: (data: string) => { output += data; } } }), sendText: () => { throw new Error('Agent output must not become shell input'); } };
		const other = { title: 'chat-b', xtermReadyPromise: Promise.resolve({ raw: { write: () => { throw new Error('Wrong session'); } } }) };
		const service = { instances: [owner, other] };
		const accessor = { get: (id: unknown) => { strictEqual(id, ITerminalService); return service; } } as unknown as ServicesAccessor;
		await command()(accessor, 'chat-a', 'Write-Output must-not-execute');
		strictEqual(output, 'Write-Output must-not-execute');
		await command()(accessor, 'missing', 'ignored');
		strictEqual(output, 'Write-Output must-not-execute');
	});

	test('ignores a closed terminal while its display is initializing', async () => {
		let ready!: (value: unknown) => void;
		const owner = { title: 'chat-a', xtermReadyPromise: new Promise(resolve => { ready = resolve; }) };
		const service = { instances: [owner] };
		const accessor = { get: () => service } as unknown as ServicesAccessor;
		const pending = command()(accessor, 'chat-a', 'late output');
		service.instances = [];
		ready({ raw: { write: () => { throw new Error('Closed terminal was reused'); } } });
		await pending;
	});
});
