/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { ExtensionMemento } from '../../common/extHostMemento.js';
import { ExtHostStorage } from '../../common/extHostStorage.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('ExtensionMemento', () => {

	ensureNoDisposablesAreLeakedInTestSuite();
	test('completes an update canceled during extension-host shutdown', async () => {
		const storage = {
			initializeExtensionStorage: async () => Object.create(null),
			onDidChangeStorage: Event.None,
			setValue: async () => { throw new CancellationError(); },
		} as unknown as ExtHostStorage;
		const memento = new ExtensionMemento('test', false, storage);

		await memento.whenReady;
		await assert.doesNotReject(memento.update('key', 'value'));
		memento.dispose();
	});
});
