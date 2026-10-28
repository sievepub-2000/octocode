/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { FoundryLocalAudioSession } from '../../node/foundryLocalAudioSession.js';

function fixture(failStart = false) {
	let resolve!: (response: { output: unknown[] }) => void;
	let reject!: (error: Error) => void;
	const response = new Promise<{ output: unknown[] }>((yes, no) => { resolve = yes; reject = no; });
	const state = { audio: [] as Uint8Array[], finished: 0, disposedQueue: 0, disposedSession: 0, request: undefined as unknown, signal: undefined as AbortSignal | undefined };
	const sdk = {
		ItemQueue: class {
			push(item: Uint8Array) { state.audio.push(item); }
			markFinished() { state.finished++; }
			dispose() { state.disposedQueue++; }
		},
		AudioSession: class {
			processStreamingRequest(request: unknown, options: { signal: AbortSignal }) {
				if (failStart) { throw new Error('session initialization failed'); }
				state.request = request;
				state.signal = options.signal;
				options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
				return {
					response,
					async *[Symbol.asyncIterator]() {
						yield { type: 'speechSegment', kind: 'partial', text: 'hello' };
						yield { type: 'speechSegment', kind: 'final', text: 'hello world' };
						await response;
					},
				};
			}
			dispose() { state.disposedSession++; }
		},
		Request: class {
			items: unknown[] = [];
			options: unknown;
			addItem(item: unknown) { this.items.push(item); }
			setOptions(options: unknown) { this.options = options; }
		},
		Item: { audioDescriptor: (format: string, sampleRate: number, channels: number) => ({ format, sampleRate, channels }), bytes: (bytes: Uint8Array) => bytes },
	};
	const session = new FoundryLocalAudioSession(sdk as unknown as typeof import('foundry-local-sdk'), {} as import('foundry-local-sdk').IModel, 'en');
	return { session, state, resolve, reject };
}

suite('FoundryLocalAudioSession', () => {
	test('copies ordered PCM input and drains final response using SDK 2 public items', async () => {
		const { session, state, resolve } = fixture();
		try {
			await session.start();
			const input = new Uint8Array([1, 2]);
			await session.append(input);
			input[0] = 9;
			await session.append(new Uint8Array([3, 4]));
			assert.deepStrictEqual(state.audio.map(bytes => [...bytes]), [[1, 2], [3, 4]]);
			const request = state.request as { items: unknown[]; options: unknown };
			assert.deepStrictEqual(request.items[0], { format: 'pcm', sampleRate: 16000, channels: 1 });
			assert.deepStrictEqual(request.options, { additionalOptions: { language: 'en' } });
			const items: unknown[] = [];
			const consume = (async () => { for await (const item of session.getStream()) { items.push(item); } })();
			const stop = session.stop();
			assert.strictEqual(state.finished, 1);
			await assert.rejects(session.append(input), /not accepting/);
			resolve({ output: [{ type: 'speechResult', text: 'hello world', segments: [] }] });
			await Promise.all([consume, stop]);
			assert.deepStrictEqual(items.map(item => (item as { type: string }).type), ['speechSegment', 'speechSegment', 'speechResult']);
		} finally { await session.dispose(); }
		assert.strictEqual(state.disposedQueue, 1);
		assert.strictEqual(state.disposedSession, 1);
	});

	test('cancel aborts native streaming and releases both handles once', async () => {
		const { session, state } = fixture();
		await session.start();
		await session.dispose();
		await session.dispose();
		assert.strictEqual(state.signal?.aborted, true);
		assert.strictEqual(state.disposedQueue, 1);
		assert.strictEqual(state.disposedSession, 1);
		await assert.rejects(session.start(), /cannot be started again/);
	});

	test('native failure before consumer start still rejects stream and stop', async () => {
		const { session, reject } = fixture();
		try {
			await session.start();
			reject(new Error('native audio failure'));
			await Promise.resolve();
			await assert.rejects(session.append(new Uint8Array([1])), /not accepting/);
			await assert.rejects(async () => { for await (const _item of session.getStream()) { /* drain */ } }, /native audio failure/);
			await assert.rejects(session.stop(), /native audio failure/);
		} finally { await session.dispose(); }
	});

	test('failed stream construction releases already allocated handles', async () => {
		const { session, state } = fixture(true);
		await assert.rejects(session.start(), /session initialization failed/);
		assert.strictEqual(state.disposedQueue, 1);
		assert.strictEqual(state.disposedSession, 1);
	});
});
