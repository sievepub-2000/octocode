/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClientAuthError, ClientAuthErrorCodes, CryptoProvider, ServerError } from '@azure/msal-node';
import type { AuthenticationResult, AuthorizationUrlRequest, InteractiveRequest, PublicClientApplication } from '@azure/msal-node';
import type { ILoopbackClientAndOpener } from '../common/loopbackClientAndOpener';

// MSAL 7 owns its HTTP loopback server; the editor's URI callback uses the explicit code-flow APIs.
export async function acquireTokenByUri(pca: Pick<PublicClientApplication, 'getAuthCodeUrl' | 'acquireTokenByCode'>, request: InteractiveRequest, loopback: ILoopbackClientAndOpener): Promise<AuthenticationResult> {
	const crypto = new CryptoProvider();
	const { verifier, challenge } = await crypto.generatePkceCodes();
	const { openBrowser, successTemplate: _success, errorTemplate: _error, windowHandle: _window, preferredPort: _port, ...parameters } = request;
	const authorization: AuthorizationUrlRequest = {
		...parameters,
		scopes: request.scopes ?? ['openid', 'profile', 'offline_access'],
		correlationId: request.correlationId || crypto.createNewGuid(),
		redirectUri: loopback.getRedirectUri(),
		state: loopback.getAuthState(crypto.createNewGuid()),
		nonce: crypto.createNewGuid(),
		responseMode: 'query',
		codeChallenge: challenge,
		codeChallengeMethod: 'S256'
	};
	try {
		const url = await pca.getAuthCodeUrl(authorization);
		const [response] = await Promise.all([loopback.listenForAuthCode(), openBrowser(url)]);
		if (response.state !== authorization.state) {
			throw new ClientAuthError(ClientAuthErrorCodes.stateMismatch, authorization.correlationId!);
		}
		if (response.error) {
			throw new ServerError(response.error, authorization.correlationId!, response.error_description);
		}
		if (!response.code) {
			throw new Error('Microsoft sign-in returned no authorization code.');
		}
		return await pca.acquireTokenByCode({ ...authorization, code: response.code, codeVerifier: verifier }, { code: response.code, state: response.state });
	} finally {
		loopback.closeServer();
	}
}
