/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { InteractiveRequest, AuthorizeResponse } from '@azure/msal-node';
import type { UriEventHandler } from '../UriEventHandler';
import { CancellationError, Disposable, env, LogOutputChannel, Uri } from 'vscode';

export interface ILoopbackClientAndOpener {
	listenForAuthCode(): Promise<AuthorizeResponse>;
	getRedirectUri(): string;
	getAuthState(nonce: string): string;
	closeServer(): void;
	openBrowser(url: string): Promise<void>;
}

export type InteractiveRequestWithLoopback = InteractiveRequest & { loopbackClient?: ILoopbackClientAndOpener };

export class UriHandlerLoopbackClient implements ILoopbackClientAndOpener {
	private _listener?: Disposable;
	private _reject?: (error: Error) => void;
	private _closed = false;
	private _authState?: string;
	private _callbackQuery?: string;
	constructor(
		private readonly _uriHandler: UriEventHandler,
		private readonly _redirectUri: string,
		private readonly _callbackUri: Uri,
		private readonly _logger: LogOutputChannel
	) { }

	async listenForAuthCode(): Promise<AuthorizeResponse> {
		if (this._closed) {
			throw new CancellationError();
		}
		return new Promise((resolve, reject) => {
			this._reject = reject;
			this._listener = this._uriHandler.event(url => {
				this._listener?.dispose();
				this._listener = undefined;
				this._reject = undefined;
				this._logger.debug(`Received URL event. Authority: ${url.authority}`);
				try {
					// URI.parse has already decoded the query. A nested callback URI's '&'
					// therefore cannot be parsed as an ordinary URLSearchParams value again.
					// Match the complete, locally generated state, including its random nonce,
					// at query-field boundaries before returning that exact bound value.
					const stateFields = [...url.query.matchAll(/(?:^|&)state=/g)];
					const stateStart = stateFields.length === 1 ? stateFields[0].index! + stateFields[0][0].length : -1;
					const expectedState = this._authState;
					const stateEnd = stateStart + (expectedState?.length ?? 0);
					const stateMatches = expectedState !== undefined && stateStart >= 0
						&& url.query.slice(stateStart, stateEnd) === expectedState
						&& (stateEnd === url.query.length || url.query[stateEnd] === '&');
					const remainingQuery = stateMatches
						? url.query.slice(0, stateFields[0].index) + url.query.slice(stateEnd)
						: url.query;
					const fields = new Map<string, string>();
					let unambiguous = stateMatches;
					for (const field of remainingQuery.split('&').filter(Boolean)) {
						const separator = field.indexOf('=');
						const key = field.slice(0, separator);
						if (separator < 0 || fields.has(key)) { unambiguous = false; }
						fields.set(key, field.slice(separator + 1));
					}
					// Routing parameters, especially authSession, must still occur exactly once
					// outside the nested state. Parse no response-supplied routing metadata.
					const permitted = new Set(['code', 'error', 'error_description', 'error_uri', 'session_state', 'client_info', 'cloud_instance_host_name', 'cloud_instance_name', 'cloud_graph_host_name', 'msgraph_host']);
					for (const field of this._callbackQuery!.split('&')) {
						const separator = field.indexOf('=');
						const key = field.slice(0, separator);
						permitted.add(key);
						if (fields.get(key) !== field.slice(separator + 1)) { unambiguous = false; }
					}
					if ([...fields.keys()].some(key => !permitted.has(key))) { unambiguous = false; }
					resolve({
						code: fields.get('code'),
						state: unambiguous ? expectedState : undefined,
						error: fields.get('error'),
						error_description: fields.get('error_description'),
						error_uri: fields.get('error_uri'),
					});
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	getRedirectUri(): string {
		// We always return the constant redirect URL because
		// it will handle redirecting back to the extension
		return this._redirectUri;
	}

	closeServer(): void {
		this._closed = true;
		this._listener?.dispose();
		this._listener = undefined;
		this._reject?.(new CancellationError());
		this._reject = undefined;
	}

	getAuthState(nonce: string): string {
		if (this._closed) {
			throw new CancellationError();
		}
		const query = new URLSearchParams(this._callbackUri.query);
		query.set('authSession', nonce);
		this._authState = this._callbackUri.with({ query: query.toString() }).toString(true);
		this._callbackQuery = Uri.parse(this._authState).query;
		return this._authState;
	}

	async openBrowser(url: string): Promise<void> {
		if (this._closed) {
			throw new CancellationError();
		}
		await env.openExternal(Uri.parse(url));
	}
}
