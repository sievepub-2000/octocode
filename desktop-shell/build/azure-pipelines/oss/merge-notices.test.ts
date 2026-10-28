/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Focused unit checks for computeUnaccounted() in merge-notices.ts.
 *
 *  Run:  npx tsx merge-notices.test.ts
 *
 *  computeUnaccounted cross-checks the scanner's "unresolved" list against the
 *  FINAL merged NOTICE to surface packages genuinely missing from it -- either
 *  (a) the scanner failed to create a row AND nothing rescued it downstream, or
 *  (b) a row exists but its license body is empty. Covers:
 *    1. A genuinely-absent unresolved pkg is included.
 *    2. An unresolved pkg that IS present in `merged` (any version) is excluded
 *       -- the linux-keyutils cglicenses.json-override rescue case.
 *    3. An entry present with empty licenseText is included (no-license-text).
 *    4. An entry present with real license text is excluded.
 *    5. Dedupe when the same pkg surfaces from both sources.
 *--------------------------------------------------------------------------------------------*/

import { computeUnaccounted } from './merge-notices.js';
import { isPackageHeader, parseNoticeFile } from './parse-notices.js';
import fs from 'fs';
import path from 'path';

interface NoticeEntry {
	name: string;
	version: string;
	license: string;
	url: string;
	licenseText: string;
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.error(`  FAIL ${name}`);
	}
}

function entry(name: string, version: string, licenseText: string): NoticeEntry {
	return { name, version, license: 'MIT', url: '', licenseText };
}

function mapOf(...entries: NoticeEntry[]): Map<string, NoticeEntry> {
	const m = new Map<string, NoticeEntry>();
	for (const e of entries) {
		m.set(`${e.name.toLowerCase()}@${e.version || ''}`, e);
	}
	return m;
}

// -- 1. genuinely-absent unresolved pkg is included ---------------------------
console.log('computeUnaccounted -- genuinely absent:');
{
	const merged = mapOf(entry('present-pkg', '1.0.0', 'Real license text'));
	const unresolved = [{ name: 'ghost-pkg', version: '2.0.0', reason: 'cargo-no-license-resolved' }];
	const out = computeUnaccounted(merged, unresolved);
	check('absent unresolved pkg is listed', out.some(u => u.name === 'ghost-pkg' && u.reason === 'cargo-no-license-resolved'));
	check('present pkg with text is NOT listed', !out.some(u => u.name === 'present-pkg'));
	check('exactly one unaccounted', out.length === 1);
}

// -- 2. unresolved pkg present in merged (any version) is excluded -------------
console.log('computeUnaccounted -- downstream-rescued (linux-keyutils case):');
{
	// Scanner failed at 0.2.4, but cglicenses.json injected it at a different
	// version. Name-only match must exclude it from the unaccounted list.
	const merged = mapOf(entry('linux-keyutils', '0.2.5', 'BSD-3-Clause text'));
	const unresolved = [{ name: 'linux-keyutils', version: '0.2.4', reason: 'cargo-no-license-resolved' }];
	const out = computeUnaccounted(merged, unresolved);
	check('rescued pkg (version drift) is excluded', !out.some(u => u.name === 'linux-keyutils'));
	check('nothing unaccounted', out.length === 0);
}
{
	// Exact-version rescue too.
	const merged = mapOf(entry('linux-keyutils', '0.2.4', 'BSD-3-Clause text'));
	const unresolved = [{ name: 'linux-keyutils', version: '0.2.4', reason: 'cargo-no-license-resolved' }];
	const out = computeUnaccounted(merged, unresolved);
	check('rescued pkg (same version) is excluded', out.length === 0);
}

// -- 3. present entry with empty license body is included ----------------------
console.log('computeUnaccounted -- empty license body:');
{
	const merged = mapOf(
		entry('blank-pkg', '1.0.0', '   \n\t  '),
		entry('good-pkg', '1.0.0', 'Real text'),
	);
	const out = computeUnaccounted(merged, []);
	check('empty-body entry listed as no-license-text', out.some(u => u.name === 'blank-pkg' && u.reason === 'no-license-text'));
	check('real-text entry excluded', !out.some(u => u.name === 'good-pkg'));
	check('exactly one unaccounted', out.length === 1);
}

// -- 4. dedupe between the two sources ----------------------------------------
console.log('computeUnaccounted -- dedupe across sources:');
{
	// Same pkg is both in unresolved AND present-with-empty-body. (Edge case, but
	// the dedupe must keep a single row keyed by name@version.)
	const merged = mapOf(entry('dup-pkg', '3.1.4', ''));
	const unresolved = [{ name: 'dup-pkg', version: '3.1.4', reason: 'cargo-api-failed' }];
	const out = computeUnaccounted(merged, unresolved);
	// Present in merged, so the unresolved branch (name-match) excludes it; the
	// empty-body branch adds it once. Either way: exactly one row, not two.
	check('single deduped row for dup-pkg', out.filter(u => u.name === 'dup-pkg').length === 1);
}
{
	// Two distinct unresolved entries for the same name@version dedupe to one.
	const merged = new Map<string, NoticeEntry>();
	const unresolved = [
		{ name: 'twice', version: '1.0.0', reason: 'cargo-api-failed' },
		{ name: 'Twice', version: '1.0.0', reason: 'cargo-no-repo-url' },
	];
	const out = computeUnaccounted(merged, unresolved);
	check('case-insensitive dedupe to one row', out.filter(u => u.name.toLowerCase() === 'twice').length === 1);
}

// -- 5. sort order ------------------------------------------------------------
console.log('computeUnaccounted -- sorted by name then version:');
{
	const merged = new Map<string, NoticeEntry>();
	const unresolved = [
		{ name: 'zeta', version: '1.0.0', reason: 'r' },
		{ name: 'alpha', version: '2.0.0', reason: 'r' },
		{ name: 'alpha', version: '1.0.0', reason: 'r' },
	];
	const out = computeUnaccounted(merged, unresolved);
	check('first is alpha@1.0.0', out[0].name === 'alpha' && out[0].version === '1.0.0');
	check('second is alpha@2.0.0', out[1].name === 'alpha' && out[1].version === '2.0.0');
	check('last is zeta', out[2].name === 'zeta');
}

// Scanner headers may have a real license body without a declared SPDX label.
// Preserve their names/versions rather than dropping mixed-case names or
// treating a version as part of the package name.
{
	const directory = fs.mkdtempSync(path.join(process.cwd(), 'notice-parser-test-'));
	try {
		const file = path.join(directory, 'notices.txt');
		const separator = '---------------------------------------------------------';
		fs.writeFileSync(file, [
			separator, 'r-efi 5.3.0', '', 'Permission to use this software.',
			separator, 'PSReadLine 2.4.4-beta4', '', 'Permission to use this software.',
			separator, 'HTML 5.1 W3C Working Draft 08 October 2015 - W3C Document License', '', 'Permission to use this document.',
			separator, 'END OF TERMS AND CONDITIONS', '', separator
		].join('\n'));
		const entries = parseNoticeFile(file);
		check('version without SPDX stays separate from package name', entries[0].name === 'r-efi' && entries[0].version === '5.3.0');
		check('mixed-case versioned package is retained without SPDX', entries[1].name === 'PSReadLine' && entries[1].version === '2.4.4-beta4');
		check('dated version preserves the document name', entries[2].name === 'HTML 5.1 W3C Working Draft' && entries[2].version === '08 October 2015');
		check('license prose is still rejected', entries.length === 3 && !isPackageHeader('END OF TERMS AND CONDITIONS'));
		check('decorative separator preserves the following legal text', entries[2].licenseText!.includes('END OF TERMS AND CONDITIONS'));
	} finally {
		fs.rmSync(directory, { recursive: true });
	}
}

// -- summary ------------------------------------------------------------------
console.log('');
console.log(`merge-notices computeUnaccounted unit checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
