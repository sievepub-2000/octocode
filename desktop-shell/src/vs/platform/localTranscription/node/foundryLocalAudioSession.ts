/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

type FoundryLocal = typeof import('foundry-local-sdk');
type IModel = import('foundry-local-sdk').IModel;
type AudioSession = import('foundry-local-sdk').AudioSession;
type ItemQueue = import('foundry-local-sdk').ItemQueue;
type StreamingResponse = import('foundry-local-sdk').StreamingResponse;
type SpeechItem = Extract<import('foundry-local-sdk').Item, { type: 'speechSegment' | 'speechResult' }>;

/** Owns one public SDK 2 audio stream and its native input/session handles. */
export class FoundryLocalAudioSession {

	private _queue: ItemQueue | undefined;
	private _session: AudioSession | undefined;
	private _stream: StreamingResponse | undefined;
	private readonly _abort = new AbortController();
	private _finished = false;

	constructor(
		private readonly _sdk: FoundryLocal,
		private readonly _model: IModel,
		private readonly _language: string | undefined,
	) { }

	async start(): Promise<void> {
		if (this._stream || this._finished) {
			throw new Error('The audio session cannot be started again.');
		}
		try {
			const queue = this._queue = new this._sdk.ItemQueue();
			const session = this._session = new this._sdk.AudioSession(this._model);
			const request = new this._sdk.Request();
			request.addItem(this._sdk.Item.audioDescriptor('pcm', 16000, 1));
			request.addItem(queue);
			if (this._language) {
				request.setOptions({ additionalOptions: { language: this._language } });
			}
			this._stream = session.processStreamingRequest(request, { signal: this._abort.signal });
			// Observe early native completion/rejection before the consumer starts.
			void this._stream.response.then(() => { this._finished = true; }, () => { this._finished = true; });
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}

	async append(pcm: Uint8Array): Promise<void> {
		if (!this._queue || this._finished) {
			throw new Error('The audio session is not accepting audio.');
		}
		this._queue.push(this._sdk.Item.bytes(pcm.slice()));
	}

	async *getStream(): AsyncGenerator<SpeechItem> {
		const stream = this._stream;
		if (!stream) {
			throw new Error('The audio session has not started.');
		}
		for await (const item of stream) {
			if (item.type === 'speechSegment') {
				yield item;
			}
		}
		const response = await stream.response;
		for (const item of response.output) {
			if (item.type === 'speechResult') {
				yield item;
			}
		}
	}

	async stop(): Promise<void> {
		this._finished = true;
		this._queue?.markFinished();
		await this._stream?.response;
	}

	async dispose(): Promise<void> {
		this._finished = true;
		this._queue?.markFinished();
		this._abort.abort();
		try {
			await this._stream?.response;
		} catch { /* cancellation and stream failures are observed by the consumer */ }
		this._session?.dispose();
		this._queue?.dispose();
		this._session = undefined;
		this._queue = undefined;
		this._stream = undefined;
	}
}
