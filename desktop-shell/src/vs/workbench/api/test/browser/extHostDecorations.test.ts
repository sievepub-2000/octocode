/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { MainThreadDecorationsShape } from '../../common/extHost.protocol.js';
import { ExtHostDecorations } from '../../common/extHostDecorations.js';
import { IExtHostRpcService } from '../../common/extHostRpcService.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';

suite('ExtHostDecorations', function () {

	let mainThreadShape: MainThreadDecorationsShape;
	let extHostDecorations: ExtHostDecorations;
	const providers = new Set<number>();

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(function () {

		providers.clear();

		mainThreadShape = new class extends mock<MainThreadDecorationsShape>() {
			override $registerDecorationProvider(handle: number) {
				providers.add(handle);
			}
			override $unregisterDecorationProvider(handle: number) {
				providers.delete(handle);
			}
		};

		extHostDecorations = new ExtHostDecorations(
			new class extends mock<IExtHostRpcService>() {
				override getProxy(): any {
					return mainThreadShape;
				}
			},
			new NullLogService()
		);
	});

	test('delivers every changed URI in bounded batches and preserves invalidation', function () {
		const emitter = disposables.add(new Emitter<URI | URI[] | undefined>());
		const batches: (string[] | null)[] = [];
		mainThreadShape.$onDidChange = (_handle, resources) => {
			batches.push(resources === null ? null : resources.map(uri => URI.revive(uri).toString()));
		};
		const registration = disposables.add(extHostDecorations.registerFileDecorationProvider({
			onDidChangeFileDecorations: emitter.event,
			provideFileDecoration: () => undefined
		}, nullExtensionDescription));
		for (const size of [0, 1, 249, 250, 251, 500, 1832, 10001]) {
			batches.length = 0;
			const uris = Array.from({ length: size }, (_, index) => URI.file(`/workspace/file-${index}`));
			emitter.fire(uris);
			assert.strictEqual(batches.length, Math.max(1, Math.ceil(size / 250)));
			assert.ok(batches.every(batch => batch !== null && batch.length <= 250));
			assert.deepStrictEqual(batches.flat(), uris.map(uri => uri.toString()));
		}
		batches.length = 0;
		emitter.fire(undefined);
		assert.deepStrictEqual(batches, [null]);
		batches.length = 0;
		const single = URI.file('/workspace/single');
		emitter.fire(single);
		assert.deepStrictEqual(batches, [[single.toString()]]);
		registration.dispose();
		batches.length = 0;
		emitter.fire(single);
		assert.deepStrictEqual(batches, []);
	});

	test('SCM Decorations missing #100524', async function () {

		let calledA = false;
		let calledB = false;

		// never returns
		extHostDecorations.registerFileDecorationProvider({

			provideFileDecoration() {
				calledA = true;
				return new Promise(() => { });
			}
		}, nullExtensionDescription);

		// always returns
		extHostDecorations.registerFileDecorationProvider({

			provideFileDecoration() {
				calledB = true;
				return new Promise(resolve => resolve({ badge: 'H', tooltip: 'Hello' }));
			}
		}, nullExtensionDescription);


		const requests = [...providers.values()].map((handle, idx) => {
			return extHostDecorations.$provideDecorations(handle, [{ id: idx, uri: URI.parse('test:///file') }], CancellationToken.None);
		});

		assert.strictEqual(calledA, true);
		assert.strictEqual(calledB, true);

		assert.strictEqual(requests.length, 2);
		const [first, second] = requests;

		const firstResult = await Promise.race([first, timeout(30).then(() => false)]);
		assert.strictEqual(typeof firstResult, 'boolean'); // never finishes...

		const secondResult = await Promise.race([second, timeout(30).then(() => false)]);
		assert.strictEqual(typeof secondResult, 'object');


		await timeout(30);
	});

});
