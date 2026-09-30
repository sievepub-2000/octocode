/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import { MainContext, ExtHostDecorationsShape, MainThreadDecorationsShape, DecorationData, DecorationRequest, DecorationReply } from './extHost.protocol.js';
import { Disposable, FileDecoration } from './extHostTypes.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { asArray } from '../../../base/common/arrays.js';
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';

interface ProviderData {
	provider: vscode.FileDecorationProvider;
	extensionDescription: IExtensionDescription;
}

export class ExtHostDecorations implements ExtHostDecorationsShape {

	private static _handlePool = 0;
	private static _maxEventSize = 250;

	readonly _serviceBrand: undefined;
	private readonly _provider = new Map<number, ProviderData>();
	private readonly _proxy: MainThreadDecorationsShape;

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@ILogService private readonly _logService: ILogService,
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadDecorations);
	}

	registerFileDecorationProvider(provider: vscode.FileDecorationProvider, extensionDescription: IExtensionDescription): vscode.Disposable {
		const handle = ExtHostDecorations._handlePool++;
		this._provider.set(handle, { provider, extensionDescription });
		this._proxy.$registerDecorationProvider(handle, extensionDescription.identifier.value);

		const listener = provider.onDidChangeFileDecorations && provider.onDidChangeFileDecorations(e => {
			if (!e) {
				this._proxy.$onDidChange(handle, null);
				return;
			}
			const array = asArray(e);
			if (array.length <= ExtHostDecorations._maxEventSize) {
				this._proxy.$onDidChange(handle, array);
				return;
			}

			for (let index = 0; index < array.length; index += ExtHostDecorations._maxEventSize) {
				this._proxy.$onDidChange(handle, array.slice(index, index + ExtHostDecorations._maxEventSize));
			}
		});

		return new Disposable(() => {
			listener?.dispose();
			this._proxy.$unregisterDecorationProvider(handle);
			this._provider.delete(handle);
		});
	}

	async $provideDecorations(handle: number, requests: DecorationRequest[], token: CancellationToken): Promise<DecorationReply> {

		if (!this._provider.has(handle)) {
			// might have been unregistered in the meantime
			return Object.create(null);
		}

		const result: DecorationReply = Object.create(null);
		const { provider, extensionDescription: extensionId } = this._provider.get(handle)!;

		await Promise.all(requests.map(async request => {
			try {
				const { uri, id } = request;
				const data = await Promise.resolve(provider.provideFileDecoration(URI.revive(uri), token));
				if (!data) {
					return;
				}
				try {
					FileDecoration.validate(data);
					if (data.badge && typeof data.badge !== 'string') {
						checkProposedApiEnabled(extensionId, 'codiconDecoration');
					}
					result[id] = <DecorationData>[data.propagate, data.tooltip, data.badge, data.color];
				} catch (e) {
					this._logService.warn(`INVALID decoration from extension '${extensionId.identifier.value}': ${e}`);
				}
			} catch (err) {
				this._logService.error(err);
			}
		}));

		return result;
	}
}

export const IExtHostDecorations = createDecorator<IExtHostDecorations>('IExtHostDecorations');
export interface IExtHostDecorations extends ExtHostDecorations { }
