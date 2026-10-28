/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { LocalTranscriptionService } from '../../node/localTranscriptionService.js';
import { FoundryLocalAudioSession } from '../../node/foundryLocalAudioSession.js';

interface SessionState {
	_generation: number;
	_sessionActive: boolean;
	_session: FoundryLocalAudioSession | undefined;
	_consume(session: FoundryLocalAudioSession, generation: number): Promise<void>;
}

function speechStream(items: unknown[]): FoundryLocalAudioSession {
	return { async *getStream() { yield* items; }, async dispose() { } } as unknown as FoundryLocalAudioSession;
}

suite('LocalTranscriptionService SDK 2 speech items', () => {
	test('cumulative hypotheses replace earlier revisions and aggregate does not duplicate segments', async () => {
		const service = new LocalTranscriptionService();
		const state = service as unknown as SessionState;
		const updates: string[] = [];
		const subscription = service.onDidTranscribe(result => updates.push(result.text));
		try {
			state._sessionActive = true;
			await state._consume(speechStream([
				{ type: 'speechSegment', kind: 'partial', text: 'hello', utteranceStart: true },
				{ type: 'speechSegment', kind: 'partial', text: 'hello world', utteranceStart: false },
				{ type: 'speechSegment', kind: 'final', text: 'hello world', startTimeMs: 0, endTimeMs: 1000 },
				{ type: 'speechSegment', kind: 'partial', text: '你好', utteranceStart: true },
				{ type: 'speechSegment', kind: 'partial', text: '你好世界', utteranceStart: false },
				{ type: 'speechResult', text: 'hello world 你好世界', segments: [] },
			]), state._generation);
			assert.deepStrictEqual(updates, ['hello', 'hello world', 'hello world', 'hello world 你好', 'hello world 你好世界', 'hello world 你好世界']);
			assert.strictEqual(await service.stop(), 'hello world 你好世界');
		} finally { subscription.dispose(); await service.cancel(); service.dispose(); }
	});

	test('late aggregate from a superseded recording cannot change the next recording', async () => {
		const service = new LocalTranscriptionService();
		const state = service as unknown as SessionState;
		try {
			await state._consume(speechStream([{ type: 'speechResult', text: 'stale transcript' }]), state._generation - 1);
			assert.strictEqual(await service.stop(), '');
		} finally { await service.cancel(); service.dispose(); }
	});

	test('native drain failure rejects stop and disposes the session', async () => {
		const service = new LocalTranscriptionService();
		const state = service as unknown as SessionState;
		let disposed = false;
		state._session = {
			async stop() { throw new Error('native drain failed'); },
			async dispose() { disposed = true; },
		} as unknown as FoundryLocalAudioSession;
		try {
			await assert.rejects(service.stop(), /native drain failed/);
			assert.strictEqual(disposed, true);
		} finally { await service.cancel(); service.dispose(); }
	});
});
