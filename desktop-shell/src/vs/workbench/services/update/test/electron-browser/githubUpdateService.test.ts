/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { State, UpdateType } from '../../../../../platform/update/common/update.js';
import { AuthenticationSession, IAuthenticationService } from '../../../authentication/common/authentication.js';
import { GitHubUpdateChannelClient } from '../../electron-browser/githubUpdateService.js';

suite('GitHub update authentication bridge', () => {
	function fixture(signedIn: boolean, confirmed = true, mode = 'manual', pickSession?: string) {
		const changed = new Emitter<{ providerId: string }>();
		const session: AuthenticationSession = { id: 'fixture-session', accessToken: 'fixture-token', account: { id: 'fixture-account', label: 'Fixture' }, scopes: ['repo', 'read:user'] };
		let sessions = signedIn ? [session] : [];
		let prompts = 0;
		let logins = 0;
		let reads = 0;
		let tokenFlow: boolean | undefined;
		const calls: { command: string; arg: unknown }[] = [];
		const channel = { listen: () => Event.None, call: async (command: string, arg: unknown) => {
			calls.push({ command, arg });
			return command === '_getInitialState' ? State.Idle(UpdateType.Setup) : undefined;
		} } as IChannel;
		const auth = { onDidChangeSessions: changed.event, getSessions: async () => { if (++reads > 20) { throw new Error('Authentication retry loop'); } return sessions; }, createSession: async (_provider: string, _scopes: string[], options: { useToken?: boolean }) => {
			tokenFlow = options.useToken;
			logins++;
			sessions = [session];
			changed.fire({ providerId: 'github' });
			return session;
		} } as unknown as IAuthenticationService;
		const client = new GitHubUpdateChannelClient(channel, auth,
			{ updateUrl: 'https://api.github.com/repos/sievepub-2000/octocode/releases/latest' } as IProductService,
			{ confirm: async () => { prompts++; return { confirmed }; } } as unknown as IDialogService,
			{ pick: async (items: { session: AuthenticationSession }[]) => items.find(item => item.session.id === pickSession) ?? items[0] } as unknown as IQuickInputService, { getValue: () => mode } as unknown as IConfigurationService);
		return { client, calls, get prompts() { return prompts; }, get logins() { return logins; }, get reads() { return reads; },
			get tokenFlow() { return tokenFlow; }, setSessions: (values: AuthenticationSession[]) => { sessions = values; },
			logout: () => { sessions = []; changed.fire({ providerId: 'github' }); }, dispose: () => { client.dispose(); changed.dispose(); } };
	}

	test('existing repo-capable session is reused without prompting', async () => {
		const value = fixture(true);
		try {
			await value.client.checkForUpdates(true);
			assert.strictEqual(value.prompts, 0);
			assert.strictEqual(value.logins, 0);
			assert.ok(value.calls.some(call => call.command === 'setGitHubToken' && call.arg === 'fixture-token'));
			assert.ok(value.calls.some(call => call.command === 'checkForUpdates' && call.arg === true));
		} finally { value.dispose(); }
	});

	test('overlapping checks do not invalidate each other indefinitely', async () => {
		const value = fixture(true);
		try {
			await Promise.all([value.client.checkForUpdates(true), value.client.checkForUpdates(false)]);
			assert.strictEqual(value.reads, 2);
			assert.strictEqual(value.calls.filter(call => call.command === 'checkForUpdates').length, 2);
		} finally { value.dispose(); }
	});

	test('explicit missing-session check offers login and continues after session event', async () => {
		const value = fixture(false);
		try {
			await value.client.checkForUpdates(true);
			assert.strictEqual(value.prompts, 1);
			assert.strictEqual(value.logins, 1);
			assert.strictEqual(value.tokenFlow, true);
			assert.strictEqual(value.calls.filter(call => call.command === 'checkForUpdates').length, 1);
		} finally { value.dispose(); }
	});

	test('background checks prefer the stored classic PAT', async () => {
		const value = fixture(false);
		try {
			value.setSessions([
				{ id: 'oauth', accessToken: 'oauth-value', account: { id: 'same', label: 'Fixture' }, scopes: ['repo'] },
				{ id: 'octocode-pat:token', accessToken: 'pat-value', account: { id: 'same', label: 'Fixture' }, scopes: ['repo'] }
			]);
			await value.client.checkForUpdates(false);
			assert.strictEqual(value.calls.find(call => call.command === 'setGitHubToken')?.arg, 'pat-value');
		} finally { value.dispose(); }
	});

	test('explicit checks can select same-account OAuth instead of a bad PAT', async () => {
		const value = fixture(false, true, 'manual', 'oauth');
		try {
			value.setSessions([
				{ id: 'octocode-pat:token', accessToken: 'bad-pat-value', account: { id: 'same', label: 'Fixture' }, scopes: ['repo'] },
				{ id: 'oauth', accessToken: 'oauth-value', account: { id: 'same', label: 'Fixture' }, scopes: ['repo'] }
			]);
			await value.client.checkForUpdates(true);
			assert.strictEqual(value.calls.find(call => call.command === 'setGitHubToken')?.arg, 'oauth-value');
		} finally { value.dispose(); }
	});

	test('declining login does not check the private release', async () => {
		const value = fixture(false, false);
		try {
			await value.client.checkForUpdates(true);
			assert.strictEqual(value.logins, 0);
			assert.strictEqual(value.calls.filter(call => call.command === 'checkForUpdates').length, 0);
		} finally { value.dispose(); }
	});

	test('background checks never display login prompts', async () => {
		const value = fixture(false);
		try {
			await value.client.checkForUpdates(false);
			assert.strictEqual(value.prompts, 0);
			assert.strictEqual(value.logins, 0);
		} finally { value.dispose(); }
	});

	test('sign-out clears the main-process credential', async () => {
		const value = fixture(true);
		try {
			await value.client.checkForUpdates(true);
			value.logout();
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.strictEqual(value.calls.filter(call => call.command === 'setGitHubToken').at(-1)?.arg, undefined);
		} finally { value.dispose(); }
	});

	test('effective policy disabling updates does not activate authentication', async () => {
		const value = fixture(false, true, 'none');
		try {
			await value.client.checkForUpdates(true);
			value.logout();
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.strictEqual(value.reads, 0);
			assert.strictEqual(value.prompts, 0);
		} finally { value.dispose(); }
	});
});
