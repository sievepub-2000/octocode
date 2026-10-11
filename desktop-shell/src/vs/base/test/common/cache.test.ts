/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../common/async.js';
import { Cache, CacheResult, LRUCachedFunction, WeakCachedFunction } from '../../common/cache.js';
import { CancellationToken } from '../../common/cancellation.js';
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

suite('Cache - Synchronous task failure', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('cancels the inaccessible task token when a legal task throws before returning its Promise', () => {
		const failure = new Error('synchronous task failure');
		let token: CancellationToken | undefined;
		let cancellations = 0;
		const cache = new Cache<number>(candidate => {
			token = candidate;
			store.add(candidate.onCancellationRequested(() => { cancellations++; }));
			throw failure;
		});
		assert.throws(() => cache.get(), function (error: unknown) { return error === failure; });
		assert.ok(token);
		assert.strictEqual(token.isCancellationRequested, true);
		assert.strictEqual(cancellations, 1);
	});

});

suite('WeakCachedFunction key contract', function () {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses undefined values for object, function and non-registered symbol keys', function () {
		const keys: WeakKey[] = [{}, function key() { }, Symbol('weak-key-fixture')];
		let calls = 0;
		const cache = new WeakCachedFunction<WeakKey, undefined>(() => { calls++; return undefined; });
		for (const key of keys) {
			assert.strictEqual(cache.get(key), undefined);
			assert.strictEqual(cache.get(key), undefined);
		}
		assert.strictEqual(calls, keys.length);
	});

	test('allows primitive arguments with a custom object key', function () {
		const key = {};
		let calls = 0;
		const cache = new WeakCachedFunction<string, string>({ getCacheKey: () => key }, arg => { calls++; return arg; });
		assert.strictEqual(cache.get('first'), 'first');
		assert.strictEqual(cache.get('second'), 'first');
		assert.strictEqual(calls, 1);
	});

	test('rejects invalid identity keys before invoking the value function', function () {
		const keys: unknown[] = [null, undefined, 'key', 1, true, 1n, Symbol.for('octocode-w41-invalid-fixture'), Symbol.for('')];
		let calls = 0;
		const cache = new WeakCachedFunction<unknown, number>(() => ++calls);
		for (const key of keys) {
			assert.throws(function () { cache.get(key); }, function (error: unknown): boolean {
				return error instanceof TypeError && error.message === 'WeakCachedFunction cache key must be an object, function, or non-registered symbol';
			});
			assert.strictEqual(calls, 0);
		}
	});

	test('rejects invalid custom keys before invoking the value function', function () {
		for (const key of [null, undefined, 'key', Symbol.for('octocode-w41-invalid-custom-fixture'), Symbol.for('')]) {
			let calls = 0;
			const cache = new WeakCachedFunction<string, number>({ getCacheKey: () => key }, () => ++calls);
			assert.throws(function () { cache.get('legal primitive argument'); }, function (error: unknown): boolean {
				return error instanceof TypeError && error.message === 'WeakCachedFunction cache key must be an object, function, or non-registered symbol';
			});
			assert.strictEqual(calls, 0);
		}
	});
});

suite('Cache - Result ownership', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('repeated disposal of an old result preserves a new entry with the same task Promise', async () => {
		let calls = 0;
		const promise = Promise.resolve(7);
		const cache = new Cache<number>(() => { calls++; return promise; });
		const first = store.add(cache.get());
		first.dispose();
		const second = store.add(cache.get());
		assert.strictEqual(first.promise, second.promise, 'Promise identity cannot stand in for entry ownership');
		first.dispose();
		const actual = store.add(cache.get());
		assert.strictEqual(actual, second);
		assert.strictEqual(calls, 2);
		assert.strictEqual(await actual.promise, 7);
	});

	test('an old result cannot invalidate the replacement created by its cancellation listener', async () => {
		let calls = 0;
		let cancellations = 0;
		let replacement: CacheResult<number> | undefined;
		const cache = new Cache<number>(token => {
			const value = ++calls;
			store.add(token.onCancellationRequested(() => {
				cancellations++;
				if (value === 1) {
					replacement = store.add(cache.get());
				}
			}));
			return Promise.resolve(value);
		});
		const first = store.add(cache.get());
		first.dispose();
		assert.ok(replacement);
		assert.strictEqual(cancellations, 1);
		first.dispose();
		const actual = store.add(cache.get());
		assert.strictEqual(actual, replacement);
		assert.strictEqual(calls, 2);
		assert.strictEqual(cancellations, 1);
		assert.strictEqual(await actual.promise, 2);
	});
});
