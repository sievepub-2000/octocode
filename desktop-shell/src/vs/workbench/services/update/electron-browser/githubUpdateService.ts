/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { getGitHubReleaseFeed } from '../../../../platform/update/common/githubUpdate.js';
import { UpdateChannelClient } from '../../../../platform/update/common/updateIpc.js';
import { IAuthenticationService } from '../../authentication/common/authentication.js';

export class GitHubUpdateChannelClient extends UpdateChannelClient {
	private readonly authenticationDisposables = new DisposableStore();
	private selectedSession: string | undefined;
	private revision = 0;

	constructor(
		channel: IChannel,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IProductService private readonly productService: IProductService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(channel);
		if (getGitHubReleaseFeed(productService.updateUrl)) {
			this.authenticationDisposables.add(authenticationService.onDidChangeSessions(event => {
				if (event.providerId === 'github') {
					this.revision++;
					const added = event.event?.added?.find(session => session.scopes.includes('repo'));
					if (added) {
						this.selectedSession = added.id;
					}
					if (configurationService.getValue<string>('update.mode') === 'none') {
						void this.setGitHubToken(undefined);
					} else {
						void this.authorize(false).catch(() => this.setGitHubToken(undefined));
					}
				}
			}));
			const mode = configurationService.getValue<string>('update.mode');
			if (mode !== 'none' && mode !== 'manual') {
				void this.authorize(false).catch(() => this.setGitHubToken(undefined));
			}
		}
	}

	private async authorize(explicit: boolean): Promise<boolean> {
		const revision = this.revision;
		const sessions = (await this.authenticationService.getSessions('github', undefined, {}, true)).filter(session => session.scopes.includes('repo'))
			.sort((a, b) => Number(b.id.startsWith('octocode-pat:')) - Number(a.id.startsWith('octocode-pat:')));
		let session = sessions.find(value => value.id === this.selectedSession) ?? sessions[0];
		if (explicit && sessions.length > 1) {
			const items = sessions.map(value => ({ label: value.account.label, description: value.id.startsWith('octocode-pat:') ? localize('update.github.token', 'GitHub token') : localize('update.github.oauth', 'GitHub sign-in'), session: value }));
			const picked = await this.quickInputService.pick(items, {
				placeHolder: localize('update.github.account', 'Choose the GitHub account with access to OctoCode releases'),
				activeItem: items.find(item => item.session === session)
			});
			if (!picked) {
				return false;
			}
			session = picked.session;
		}
		if (!session && explicit) {
			const result = await this.dialogService.confirm({
				message: localize('update.github.signIn', 'Use a GitHub token to check private OctoCode updates.'),
				detail: localize('update.github.access', 'Use a classic token with repo access. GitHub Authentication stores it securely. You can also run Sign in to GitHub for Updates to use browser authorization.'),
				primaryButton: localize('update.github.signInButton', 'Use GitHub Token')
			});
			if (!result.confirmed) {
				await this.setGitHubToken(undefined);
				return false;
			}
			session = await this.authenticationService.createSession('github', ['repo'], { activateImmediate: true, useToken: true });
		}
		// A sign-out/refresh that arrived during an async selection wins.
		if (revision !== this.revision) {
			return this.authorize(false);
		}
		this.selectedSession = session?.id;
		await this.setGitHubToken(session?.accessToken);
		return !!session;
	}

	override async checkForUpdates(explicit: boolean): Promise<void> {
		if (this.configurationService.getValue<string>('update.mode') !== 'none' && getGitHubReleaseFeed(this.productService.updateUrl) && !await this.authorize(explicit)) {
			return;
		}
		return super.checkForUpdates(explicit);
	}

	override dispose(): void {
		this.authenticationDisposables.dispose();
		super.dispose();
	}
}
