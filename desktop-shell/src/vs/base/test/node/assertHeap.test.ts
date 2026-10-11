/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';
import type { ISnapshotAssertOptions } from '../common/assertHeap.js';

const vm = process.getBuiltinModule('vm');

interface SnapshotData {
	done: Promise<number[]>;
	file: string;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
	return { promise, resolve, reject };
}

async function fixture(analyze: (test: string, classes: readonly string[]) => Promise<SnapshotData>) {
	assert.strictEqual(typeof vm.SourceTextModule, 'function', 'ESM vm tests require --experimental-vm-modules');
	const helperURL = new URL('../common/assertHeap.js', import.meta.url);
	const entireCompiledHelper = readFileSync(helperURL, 'utf8');
	let setupHook: ((this: { currentTest: { fullTitle(): string; timeout(value?: number): number } }) => void) | undefined;
	let teardownHook: (() => Promise<void>) | undefined;
	let timeout = 1000;
	const context = vm.createContext({
		setup(hook: typeof setupHook) { setupHook = hook; },
		suiteTeardown(hook: typeof teardownHook) { teardownHook = hook; },
		__analyzeSnapshotInTests: analyze,
	});
	const helper = new vm.SourceTextModule(entireCompiledHelper, { context, identifier: helperURL.href });
	await helper.link(function (specifier) { throw new Error(`Unexpected helper import: ${specifier}`); });
	await helper.evaluate();
	assert.ok(setupHook);
	assert.ok(teardownHook);
	setupHook.call({ currentTest: {
		fullTitle() { return 'assertHeap vm counts fixture'; },
		timeout(value?: number) { if (value !== undefined) { timeout = value; } return timeout; },
	} });
	const run = (helper.namespace as { assertHeap: (opts: ISnapshotAssertOptions) => Promise<void> }).assertHeap;
	assert.strictEqual(typeof run, 'function');
	return { run, teardown: teardownHook, timeout: () => timeout };
}

suite('assertHeap compiled helper with isolated counts data', function () {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('failed analyzer or assertion teardown does not repeat its batch', async function () {
		for (const failureAt of ['counts', 'assertion']) {
			const counts = deferred<number[]>();
			const failure = new Error(`synthetic ${failureAt} failure`);
			const f = await fixture(async () => ({ done: counts.promise, file: 'fixture-only-snapshot.json' }));
			let assertions = 0;
			await f.run({ classes: { Thing: () => { assertions++; if (failureAt === 'assertion') { throw failure; } } } });
			const drain = f.teardown();
			const rejected = assert.rejects(drain, function (error: unknown): boolean {
				if (failureAt === 'counts') { return error === failure; }
				return typeof error === 'object' && error !== null
					&& String(error).includes(failure.message) && String(error).includes('fixture-only-snapshot.json');
			});
			try {
				if (failureAt === 'counts') { counts.reject(failure); } else { counts.resolve([0]); }
				await rejected;
				await f.teardown();
				assert.strictEqual(assertions, failureAt === 'assertion' ? 1 : 0);
			} finally {
				counts.resolve([0]);
				await drain.catch(() => undefined);
			}
		}
	});

	test('a new batch queued while teardown awaits is retained for the next teardown', async function () {
		const firstCounts = deferred<number[]>();
		let requests = 0;
		const f = await fixture(async () => ({ done: requests++ === 0 ? firstCounts.promise : Promise.resolve([2]), file: 'fixture-only-snapshot.json' }));
		const asserted: string[] = [];
		await f.run({ classes: { First: count => { assert.strictEqual(count, 1); asserted.push('first'); } } });
		const drain = f.teardown();
		try {
			await f.run({ classes: { Next: count => { assert.strictEqual(count, 2); asserted.push('next'); } } });
			firstCounts.resolve([1]);
			await drain;
			assert.deepStrictEqual(asserted, ['first']);
			await f.teardown();
			assert.deepStrictEqual(asserted, ['first', 'next']);
		} finally {
			firstCounts.resolve([1]);
			await drain.catch(() => undefined);
		}
	});

	test('captures class names and assertions before awaiting the analyzer provider', async function () {
		const started = deferred<SnapshotData>();
		const names: string[][] = [];
		const f = await fixture(async (_test, classes) => { names.push([...classes]); return started.promise; });
		const asserted: number[] = [];
		let mutatedAssertions = 0;
		const opts: ISnapshotAssertOptions = { classes: { Original: count => asserted.push(count) } };
		const pending = f.run(opts);
		try {
			opts.classes.Original = () => { mutatedAssertions++; };
			delete opts.classes.Original;
			opts.classes.Replacement = () => { mutatedAssertions++; };
			started.resolve({ done: Promise.resolve([7]), file: 'fixture-only-snapshot.json' });
			await pending;
			opts.classes.Later = () => { mutatedAssertions++; };
			await f.teardown();
			assert.deepStrictEqual(names, [['Original']]);
			assert.deepStrictEqual(asserted, [7]);
			assert.strictEqual(mutatedAssertions, 0);
			assert.deepStrictEqual(Object.keys(opts.classes), ['Replacement', 'Later']);
		} finally {
			started.resolve({ done: Promise.resolve([7]), file: 'fixture-only-snapshot.json' });
			await pending;
		}
	});

	test('retains the 20s helper timeout and Promise.all first-error behavior', async function () {
		const firstCounts = deferred<number[]>();
		const secondCounts = deferred<number[]>();
		let requests = 0;
		const f = await fixture(async () => ({ done: requests++ === 0 ? firstCounts.promise : secondCounts.promise, file: 'fixture-only-snapshot.json' }));
		await f.run({ classes: { First: () => { } } });
		await f.run({ classes: { Second: () => { } } });
		assert.strictEqual(f.timeout(), 20_000);
		const first = new Error('synthetic first analysis failure');
		const second = new Error('synthetic second analysis failure');
		const observedSecond = secondCounts.promise.then(() => undefined, (error: unknown) => error);
		const drain = f.teardown();
		const rejected = assert.rejects(drain, function (error: unknown): boolean { return error === first; });
		try {
			firstCounts.reject(first);
			await rejected;
			secondCounts.reject(second);
			assert.strictEqual(await observedSecond, second);
			await f.teardown();
		} finally {
			firstCounts.resolve([0]);
			secondCounts.resolve([0]);
			await drain.catch(() => undefined);
			await observedSecond;
		}
	});
});
