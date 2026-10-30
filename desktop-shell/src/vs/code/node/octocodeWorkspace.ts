/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises } from 'fs';
import { resolve } from 'path';

export async function ensureOctoCodeWorkspace(appRoot: string): Promise<void> {
	const workspace = resolve(appRoot, '..', '..', 'workspace');
	await promises.mkdir(workspace, { recursive: true });
	const marker = await promises.open(resolve(workspace, 'Program'), 'a');
	await marker.close();
}
