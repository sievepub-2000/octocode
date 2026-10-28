/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { inspect } from 'util';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { NullLogService } from '../../../log/common/log.js';
import { AbstractRequestService } from '../../common/request.js';

suite('Private update request diagnostics', () => {
	test('signed URLs, Authorization and redirect locations stay out of trace and error logs', async () => {
		const records: unknown[][] = [];
		class Log extends NullLogService {
			override trace(...args: unknown[]): void { records.push(args); }
			override error(...args: unknown[]): void { records.push(args); }
		}
		class Request extends AbstractRequestService {
			fail = false;
			constructor() { super(new Log()); }
			request(options: IRequestOptions): Promise<IRequestContext> {
				return this.logAndRequest(options, async () => {
					if (this.fail) { throw new Error('transport https://example.test/?fixture-signature=private'); }
					return { res: { statusCode: 302, headers: { location: 'https://example.test/?fixture-signature=private' } }, stream: bufferToStream(VSBuffer.alloc(0)) };
				});
			}
			async resolveProxy(): Promise<undefined> { return undefined; }
			async lookupAuthorization(): Promise<undefined> { return undefined; }
			async lookupKerberosAuthorization(): Promise<undefined> { return undefined; }
			async loadCertificates(): Promise<string[]> { return []; }
		}
		const service = new Request();
		try {
			const options = { url: 'https://example.test/?fixture-signature=private', headers: { Authorization: 'Bearer fixture-secret' }, sensitive: true, callSite: 'test.private' };
			await service.request(options);
			service.fail = true;
			await assert.rejects(service.request(options));
			const output = JSON.stringify(records) + inspect(records, { depth: 8 });
			assert.ok(!output.includes('fixture-secret'));
			assert.ok(!output.includes('fixture-signature'));
			assert.ok(output.includes('Private request failed'));
		} finally { service.dispose(); }
	});
});
