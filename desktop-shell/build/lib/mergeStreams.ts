/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PassThrough } from 'node:stream';

export function mergeStreams(...sources: NodeJS.ReadableStream[] | [NodeJS.ReadableStream[]]): NodeJS.ReadWriteStream {
	const streams = Array.isArray(sources[0]) ? sources[0] : sources as NodeJS.ReadableStream[];
	const output = new PassThrough({ objectMode: true });
	const forward = (stream: NodeJS.ReadableStream) => new Promise<void>((resolve, reject) => {
		stream.on('data', value => {
			if (!output.write(value)) {
				stream.pause();
				output.once('drain', () => stream.resume());
			}
		});
		stream.once('end', resolve);
		stream.once('error', reject);
	});
	void Promise.all(streams.map(forward)).then(() => output.end(), error => output.destroy(error));
	return output;
}
