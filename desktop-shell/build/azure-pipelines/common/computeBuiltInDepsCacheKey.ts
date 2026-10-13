/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getCurrentExtensionTarget } from '../../lib/extensionTarget.ts';

const productjson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../product.json'), 'utf8'));
const shasum = crypto.createHash('sha256');

// Only fold the build target into the key when at least one built-in extension is platform-specific.
// Otherwise the cache stays shared across platforms (as before), so a single platform populates it
// and the rest reuse it instead of each re-downloading.
const hasPlatformSpecific = (productjson.builtInExtensions as { platformSpecific?: unknown }[]).some(ext => ext.platformSpecific);
const target = hasPlatformSpecific ? getCurrentExtensionTarget() : undefined;
const extensions = (productjson.builtInExtensions as {
	name: string;
	version: string;
	platformSpecific?: Record<string, string>;
}[]).map(ext => [
	ext.name,
	ext.version,
	ext.platformSpecific && target && ext.platformSpecific[target] ? ext.platformSpecific[target] : null
]);

// Encode field and extension boundaries so distinct lists cannot share the same hash input.
shasum.update(JSON.stringify([target, extensions]));

process.stdout.write(shasum.digest('hex'));
