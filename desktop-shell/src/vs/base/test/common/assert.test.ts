/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ok, assert as commonAssert } from '../../common/assert.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';
import { CancellationError, ReadonlyError } from '../../common/errors.js';

suite('Assert', () => {
	test('ok', () => {
		assert.throws(function () {
			ok(false);
		});

		assert.throws(function () {
			ok(null);
		});

		assert.throws(function () {
			ok();
		});

		assert.throws(function () {
			ok(null, 'Foo Bar');
		}, function (e: Error) {
			return e.message.indexOf('Foo Bar') >= 0;
		});

		ok(true);
		ok('foo');
		ok({});
		ok(5);
	});

	suite('throws a provided error object', () => {
		test('generic error', () => {
			const originalError = new Error('Oh no!');

			assert.throws(() => commonAssert(false, originalError), function (thrownError: Error) {
				assert.strictEqual(thrownError, originalError, 'Must throw the provided error instance.');
				assert.strictEqual(thrownError.message, 'Oh no!', 'Must contain the expected message.');
				return true;
			});
		});

		test('cancellation error', () => {
			const originalError = new CancellationError();

			assert.throws(() => commonAssert(false, originalError), function (thrownError: Error) {
				assert.strictEqual(thrownError, originalError, 'Must throw the provided error instance.');
				return true;
			});
		});

		test('readonly error', () => {
			const originalError = new ReadonlyError('World');

			assert.throws(() => commonAssert(false, originalError), function (thrownError: Error) {
				assert.strictEqual(thrownError, originalError, 'Must throw the provided error instance.');
				assert.strictEqual(thrownError.message, 'World is read-only and cannot be changed', 'Must contain the expected message.');
				return true;
			});
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
