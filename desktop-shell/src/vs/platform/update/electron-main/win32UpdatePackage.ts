/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { checksum } from '../../../base/node/crypto.js';
import { stat } from 'fs/promises';
import { IUpdate } from '../common/update.js';

export function validateWindowsUpdate(update: IUpdate): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(update.version) || update.version.includes('..')) {
		throw new Error('Invalid Windows update version');
	}
	if (!update.sha256hash || !/^[a-fA-F0-9]{64}$/.test(update.sha256hash)) {
		throw new Error('Windows updates require a SHA-256 checksum');
	}
	if (!update.url || new URL(update.url).protocol !== 'https:') {
		throw new Error('Windows updates require an HTTPS download URL');
	}
	if (update.size !== undefined && (!Number.isSafeInteger(update.size) || update.size <= 0)) {
		throw new Error('Invalid Windows update size');
	}
}

export async function verifyWindowsUpdatePackage(packagePath: string, update: IUpdate): Promise<void> {
	validateWindowsUpdate(update);
	if (update.size !== undefined && (await stat(packagePath)).size !== update.size) {
		throw new Error('Windows update package size does not match its signed metadata');
	}
	await checksum(packagePath, update.sha256hash!.toLowerCase());
}
