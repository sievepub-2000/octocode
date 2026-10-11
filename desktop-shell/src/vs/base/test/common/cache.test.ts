/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../common/async.js';
import { Cache, LRUCachedFunction } from '../../common/cache.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('Cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('simple value', () => {
		let counter = 0;
		const cache = new Cache(_ => Promise.resolve(counter++));

		return cache.get().promise
			.then(c => assert.strictEqual(c, 0), () => assert.fail('Unexpected assertion error'))
			.then(() => cache.get().promise)
			.then(c => assert.strictEqual(c, 0), () => assert.fail('Unexpected assertion error'));
	});

	test('simple error', () => {
		let counter = 0;
		const cache = new Cache(_ => Promise.reject(new Error(String(counter++))));

		return cache.get().promise
			.then(() => assert.fail('Unexpected assertion error'), err => assert.strictEqual(err.message, '0'))
			.then(() => cache.get().promise)
			.then(() => assert.fail('Unexpected assertion error'), err => assert.strictEqual(err.message, '0'));
	});

	test('should retry cancellations', () => {
		let counter1 = 0, counter2 = 0;

		const cache = new Cache(token => {
			counter1++;
			return Promise.resolve(timeout(2, token).then(() => counter2++));
		});

		assert.strictEqual(counter1, 0);
		assert.strictEqual(counter2, 0);
		let result = cache.get();
		assert.strictEqual(counter1, 1);
		assert.strictEqual(counter2, 0);
		result.promise.then(undefined, () => assert(true));
		result.dispose();
		assert.strictEqual(counter1, 1);
		assert.strictEqual(counter2, 0);

		result = cache.get();
		assert.strictEqual(counter1, 2);
		assert.strictEqual(counter2, 0);

		return result.promise
			.then(c => {
				assert.strictEqual(counter1, 2);
				assert.strictEqual(counter2, 1);
			})
			.then(() => cache.get().promise)
			.then(c => {
				assert.strictEqual(counter1, 2);
				assert.strictEqual(counter2, 1);
			});
	});
});


suite('LRUCachedFunction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('computes the first undefined identity key', () => {
		let calls = 0;
		const cache = new LRUCachedFunction<undefined, number>(() => ++calls);
		assert.strictEqual(cache.get(undefined), 1);
		assert.strictEqual(cache.get(undefined), 1);
		assert.strictEqual(calls, 1);
	});

	test('computes the first undefined custom key', () => {
		let calls = 0;
		const cache = new LRUCachedFunction({ getCacheKey: (_arg: string) => undefined }, () => ++calls);
		assert.strictEqual(cache.get('first'), 1);
		assert.strictEqual(cache.get('same key'), 1);
		assert.strictEqual(calls, 1);
	});

	test('caches a computed undefined value', () => {
		let calls = 0;
		const cache = new LRUCachedFunction<undefined, undefined>(() => { calls++; return undefined; });
		assert.strictEqual(cache.get(undefined), undefined);
		assert.strictEqual(cache.get(undefined), undefined);
		assert.strictEqual(calls, 1);
	});

	test('does not commit a key when the computation throws', () => {
		let calls = 0;
		const error = new Error('calculation failed');
		const cache = new LRUCachedFunction((arg: string) => {
			calls++;
			if (arg === 'failing' && calls === 2) { throw error; }
			return arg;
		});
		assert.strictEqual(cache.get('previous'), 'previous');
		assert.throws(() => cache.get('failing'), function (e: unknown) { return e === error; });
		assert.strictEqual(cache.get('previous'), 'previous');
		assert.strictEqual(calls, 2);
		assert.strictEqual(cache.get('failing'), 'failing');
		assert.strictEqual(calls, 3);
	});
});
