/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Log } from './logger';

export class Keychain {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly serviceId: string,
		private readonly Logger: Log
	) { }

	async setToken(token: string): Promise<void> {
		try {
			return await this.context.secrets.store(this.serviceId, token);
		} catch {
			this.Logger.error('Setting GitHub credentials in secure storage failed');
			throw new Error('GitHub credential storage failed');
		}
	}

	async getToken(): Promise<string | null | undefined> {
		try {
			const secret = await this.context.secrets.get(this.serviceId);
			if (secret && secret !== '[]') {
				this.Logger.trace('Token acquired from secret storage.');
			}
			return secret;
		} catch {
			this.Logger.error('Reading GitHub credentials from secure storage failed');
			return Promise.resolve(undefined);
		}
	}

	async deleteToken(): Promise<void> {
		try {
			return await this.context.secrets.delete(this.serviceId);
		} catch {
			this.Logger.error('Deleting GitHub credentials from secure storage failed');
			throw new Error('GitHub credential deletion failed');
		}
	}
}
