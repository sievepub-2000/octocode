/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import { Git, Repository, GitError, GitStatusParser, parseGitCommits, parseGitmodules, parseLsTree, parseLsFiles, parseGitRemotes, parseCoAuthors } from '../git';
import * as assert from 'assert';
import { splitInChunks } from '../util';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { CancellationError, EventEmitter, type LogOutputChannel } from 'vscode';
import * as http from 'http';
import { GitErrorCodes, RefType, Status } from '../api/git.constants';
import { fromGitUri, toMultiFileDiffEditorUris } from '../uri';
import type { Socket } from 'net';

suite('git', () => {
	suite('GitStatusParser', () => {
		test('empty parser', () => {
			const parser = new GitStatusParser();
			assert.deepStrictEqual(parser.status, []);
		});

		test('empty parser 2', () => {
			const parser = new GitStatusParser();
			parser.update('');
			assert.deepStrictEqual(parser.status, []);
		});

		test('simple', () => {
			const parser = new GitStatusParser();
			parser.update('?? file.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('simple 2', () => {
			const parser = new GitStatusParser();
			parser.update('?? file.txt\0');
			parser.update('?? file2.txt\0');
			parser.update('?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('empty lines', () => {
			const parser = new GitStatusParser();
			parser.update('');
			parser.update('?? file.txt\0');
			parser.update('');
			parser.update('');
			parser.update('?? file2.txt\0');
			parser.update('');
			parser.update('?? file3.txt\0');
			parser.update('');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('combined', () => {
			const parser = new GitStatusParser();
			parser.update('?? file.txt\0?? file2.txt\0?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('split 1', () => {
			const parser = new GitStatusParser();
			parser.update('?? file.txt\0?? file2');
			parser.update('.txt\0?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('split 2', () => {
			const parser = new GitStatusParser();
			parser.update('?? file.txt');
			parser.update('\0?? file2.txt\0?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('split 3', () => {
			const parser = new GitStatusParser();
			parser.update('?? file.txt\0?? file2.txt\0?? file3.txt');
			parser.update('\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('rename', () => {
			const parser = new GitStatusParser();
			parser.update('R  newfile.txt\0file.txt\0?? file2.txt\0?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: 'newfile.txt', x: 'R', y: ' ' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('rename split', () => {
			const parser = new GitStatusParser();
			parser.update('R  newfile.txt\0fil');
			parser.update('e.txt\0?? file2.txt\0?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file.txt', rename: 'newfile.txt', x: 'R', y: ' ' },
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});

		test('rename split 3', () => {
			const parser = new GitStatusParser();
			parser.update('?? file2.txt\0R  new');
			parser.update('file.txt\0fil');
			parser.update('e.txt\0?? file3.txt\0');
			assert.deepStrictEqual(parser.status, [
				{ path: 'file2.txt', rename: undefined, x: '?', y: '?' },
				{ path: 'file.txt', rename: 'newfile.txt', x: 'R', y: ' ' },
				{ path: 'file3.txt', rename: undefined, x: '?', y: '?' }
			]);
		});
	});

	suite('parseGitmodules', () => {
		test('empty', () => {
			assert.deepStrictEqual(parseGitmodules(''), []);
		});

		test('sample', () => {
			const sample = `[submodule "deps/spdlog"]
	path = deps/spdlog
	url = https://github.com/gabime/spdlog.git
`;

			assert.deepStrictEqual(parseGitmodules(sample), [
				{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' }
			]);
		});

		test('big', () => {
			const sample = `[submodule "deps/spdlog"]
	path = deps/spdlog
	url = https://github.com/gabime/spdlog.git
[submodule "deps/spdlog2"]
	path = deps/spdlog2
	url = https://github.com/gabime/spdlog.git
[submodule "deps/spdlog3"]
	path = deps/spdlog3
	url = https://github.com/gabime/spdlog.git
[submodule "deps/spdlog4"]
	path = deps/spdlog4
	url = https://github.com/gabime/spdlog4.git
`;

			assert.deepStrictEqual(parseGitmodules(sample), [
				{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' },
				{ name: 'deps/spdlog2', path: 'deps/spdlog2', url: 'https://github.com/gabime/spdlog.git' },
				{ name: 'deps/spdlog3', path: 'deps/spdlog3', url: 'https://github.com/gabime/spdlog.git' },
				{ name: 'deps/spdlog4', path: 'deps/spdlog4', url: 'https://github.com/gabime/spdlog4.git' }
			]);
		});

		test('whitespace #74844', () => {
			const sample = `[submodule "deps/spdlog"]
	path = deps/spdlog
	url  = https://github.com/gabime/spdlog.git
`;

			assert.deepStrictEqual(parseGitmodules(sample), [
				{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' }
			]);
		});

		test('whitespace again #108371', () => {
			const sample = `[submodule "deps/spdlog"]
	path= deps/spdlog
	url=https://github.com/gabime/spdlog.git
`;

			assert.deepStrictEqual(parseGitmodules(sample), [
				{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' }
			]);
		});
	});

	suite('parseGitRemotes', () => {
		test('empty', () => {
			assert.deepStrictEqual(parseGitRemotes(''), []);
		});

		test('single remote', () => {
			const sample = `[remote "origin"]
	url = https://github.com/microsoft/vscode.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;

			assert.deepStrictEqual(parseGitRemotes(sample), [
				{ name: 'origin', fetchUrl: 'https://github.com/microsoft/vscode.git', pushUrl: 'https://github.com/microsoft/vscode.git', isReadOnly: false }
			]);
		});

		test('single remote (multiple urls)', () => {
			const sample = `[remote "origin"]
	url = https://github.com/microsoft/vscode.git
	url = https://github.com/microsoft/vscode2.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;

			assert.deepStrictEqual(parseGitRemotes(sample), [
				{ name: 'origin', fetchUrl: 'https://github.com/microsoft/vscode.git', pushUrl: 'https://github.com/microsoft/vscode.git', isReadOnly: false }
			]);
		});

		test('multiple remotes', () => {
			const sample = `[remote "origin"]
	url = https://github.com/microsoft/vscode.git
	pushurl = https://github.com/microsoft/vscode1.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[remote "remote2"]
	url = https://github.com/microsoft/vscode2.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;

			assert.deepStrictEqual(parseGitRemotes(sample), [
				{ name: 'origin', fetchUrl: 'https://github.com/microsoft/vscode.git', pushUrl: 'https://github.com/microsoft/vscode1.git', isReadOnly: false },
				{ name: 'remote2', fetchUrl: 'https://github.com/microsoft/vscode2.git', pushUrl: 'https://github.com/microsoft/vscode2.git', isReadOnly: false }
			]);
		});

		test('remotes (white space)', () => {
			const sample = ` [remote "origin"]
	url  =  https://github.com/microsoft/vscode.git
	pushurl=https://github.com/microsoft/vscode1.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[ remote"remote2"]
	url = https://github.com/microsoft/vscode2.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;

			assert.deepStrictEqual(parseGitRemotes(sample), [
				{ name: 'origin', fetchUrl: 'https://github.com/microsoft/vscode.git', pushUrl: 'https://github.com/microsoft/vscode1.git', isReadOnly: false },
				{ name: 'remote2', fetchUrl: 'https://github.com/microsoft/vscode2.git', pushUrl: 'https://github.com/microsoft/vscode2.git', isReadOnly: false }
			]);
		});

		test('remotes (invalid section)', () => {
			const sample = `[remote "origin"
	url = https://github.com/microsoft/vscode.git
	pushurl = https://github.com/microsoft/vscode1.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;

			assert.deepStrictEqual(parseGitRemotes(sample), []);
		});
	});

	suite('parseGitCommit', () => {
		test('single parent commit', function () {
			const GIT_OUTPUT_SINGLE_PARENT =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554\n' +
				'main, branch\n' +
				'This is a commit message.\x00';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_SINGLE_PARENT), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385554'],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main', 'branch'],
				shortStat: undefined,
				coAuthors: []
			}]);
		});

		test('multiple parent commits', function () {
			const GIT_OUTPUT_MULTIPLE_PARENTS =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554 df27d8c75b129ab9b178b386077da2822101b217\n' +
				'main\n' +
				'This is a commit message.\x00';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_MULTIPLE_PARENTS), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385554', 'df27d8c75b129ab9b178b386077da2822101b217'],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main'],
				shortStat: undefined,
				coAuthors: []
			}]);
		});

		test('no parent commits', function () {
			const GIT_OUTPUT_NO_PARENTS =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'\n' +
				'main\n' +
				'This is a commit message.\x00';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_NO_PARENTS), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: [],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main'],
				shortStat: undefined,
				coAuthors: []
			}]);
		});

		test('commit with shortstat', function () {
			const GIT_OUTPUT_SINGLE_PARENT =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554\n' +
				'main, branch\n' +
				'This is a commit message.\x00\n' +
				' 1 file changed, 2 insertions(+), 3 deletion(-)';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_SINGLE_PARENT), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385554'],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main', 'branch'],
				shortStat: {
					deletions: 3,
					files: 1,
					insertions: 2
				},
				coAuthors: []
			}]);
		});

		test('commit with shortstat (no insertions)', function () {
			const GIT_OUTPUT_SINGLE_PARENT =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554\n' +
				'main, branch\n' +
				'This is a commit message.\x00\n' +
				' 1 file changed, 3 deletion(-)';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_SINGLE_PARENT), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385554'],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main', 'branch'],
				shortStat: {
					deletions: 3,
					files: 1,
					insertions: 0
				},
				coAuthors: []
			}]);
		});

		test('commit with shortstat (no deletions)', function () {
			const GIT_OUTPUT_SINGLE_PARENT =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554\n' +
				'main, branch\n' +
				'This is a commit message.\x00\n' +
				' 1 file changed, 2 insertions(+)';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_SINGLE_PARENT), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385554'],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main', 'branch'],
				shortStat: {
					deletions: 0,
					files: 1,
					insertions: 2
				},
				coAuthors: []
			}]);
		});

		test('commit list', function () {
			const GIT_OUTPUT_SINGLE_PARENT =
				'52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554\n' +
				'main, branch\n' +
				'This is a commit message.\x00\n' +
				'52c293a05038d865604c2284aa8698bd087915a2\n' +
				'Jane Doe\n' +
				'jane.doe@mail.com\n' +
				'1580811032\n' +
				'1580811033\n' +
				'8e5a374372b8393906c7e380dbb09349c5385555\n' +
				'main, branch\n' +
				'This is another commit message.\x00';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_SINGLE_PARENT), [
				{
					hash: '52c293a05038d865604c2284aa8698bd087915a1',
					message: 'This is a commit message.',
					parents: ['8e5a374372b8393906c7e380dbb09349c5385554'],
					authorDate: new Date(1580811030000),
					authorName: 'John Doe',
					authorEmail: 'john.doe@mail.com',
					commitDate: new Date(1580811031000),
					refNames: ['main', 'branch'],
					shortStat: undefined,
					coAuthors: []
				},
				{
					hash: '52c293a05038d865604c2284aa8698bd087915a2',
					message: 'This is another commit message.',
					parents: ['8e5a374372b8393906c7e380dbb09349c5385555'],
					authorDate: new Date(1580811032000),
					authorName: 'Jane Doe',
					authorEmail: 'jane.doe@mail.com',
					commitDate: new Date(1580811033000),
					refNames: ['main', 'branch'],
					shortStat: undefined,
					coAuthors: []
				},
			]);
		});

		test('commit list with shortstat', function () {
			const GIT_OUTPUT_SINGLE_PARENT = '52c293a05038d865604c2284aa8698bd087915a1\n' +
				'John Doe\n' +
				'john.doe@mail.com\n' +
				'1580811030\n' +
				'1580811031\n' +
				'8e5a374372b8393906c7e380dbb09349c5385554\n' +
				'main, branch\n' +
				'This is a commit message.\x00\n' +
				' 5 file changed, 12 insertions(+), 13 deletion(-)\n' +
				'52c293a05038d865604c2284aa8698bd087915a2\n' +
				'Jane Doe\n' +
				'jane.doe@mail.com\n' +
				'1580811032\n' +
				'1580811033\n' +
				'8e5a374372b8393906c7e380dbb09349c5385555\n' +
				'main, branch\n' +
				'This is another commit message.\x00\n' +
				' 6 file changed, 22 insertions(+), 23 deletion(-)';

			assert.deepStrictEqual(parseGitCommits(GIT_OUTPUT_SINGLE_PARENT), [{
				hash: '52c293a05038d865604c2284aa8698bd087915a1',
				message: 'This is a commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385554'],
				authorDate: new Date(1580811030000),
				authorName: 'John Doe',
				authorEmail: 'john.doe@mail.com',
				commitDate: new Date(1580811031000),
				refNames: ['main', 'branch'],
				shortStat: {
					deletions: 13,
					files: 5,
					insertions: 12
				},
				coAuthors: []
			},
			{
				hash: '52c293a05038d865604c2284aa8698bd087915a2',
				message: 'This is another commit message.',
				parents: ['8e5a374372b8393906c7e380dbb09349c5385555'],
				authorDate: new Date(1580811032000),
				authorName: 'Jane Doe',
				authorEmail: 'jane.doe@mail.com',
				commitDate: new Date(1580811033000),
				refNames: ['main', 'branch'],
				shortStat: {
					deletions: 23,
					files: 6,
					insertions: 22
				},
				coAuthors: []
			}]);
		});
	});

	suite('parseLsTree', function () {
		test('sample', function () {
			const input = `040000 tree 0274a81f8ee9ca3669295dc40f510bd2021d0043       -	.vscode
100644 blob 1d487c1817262e4f20efbfa1d04c18f51b0046f6  491570	Screen Shot 2018-06-01 at 14.48.05.png
100644 blob 686c16e4f019b734655a2576ce8b98749a9ffdb9  764420	Screen Shot 2018-06-07 at 20.04.59.png
100644 blob 257cc5642cb1a054f08cc83f2d943e56fd3ebe99       4	boom.txt
100644 blob 86dc360dd25f13fa50ffdc8259e9653921f4f2b7      11	boomcaboom.txt
100644 blob a68b14060589b16d7ac75f67b905c918c03c06eb      24	file.js
100644 blob f7bcfb05af46850d780f88c069edcd57481d822d     201	file.md
100644 blob ab8b86114a051f6490f1ec5e3141b9a632fb46b5       8	hello.js
100644 blob 257cc5642cb1a054f08cc83f2d943e56fd3ebe99       4	what.js
100644 blob be859e3f412fa86513cd8bebe8189d1ea1a3e46d      24	what.txt
100644 blob 56ec42c9dc6fcf4534788f0fe34b36e09f37d085  261186	what.txt2`;

			const output = parseLsTree(input);

			assert.deepStrictEqual(output, [
				{ mode: '040000', type: 'tree', object: '0274a81f8ee9ca3669295dc40f510bd2021d0043', size: '-', file: '.vscode' },
				{ mode: '100644', type: 'blob', object: '1d487c1817262e4f20efbfa1d04c18f51b0046f6', size: '491570', file: 'Screen Shot 2018-06-01 at 14.48.05.png' },
				{ mode: '100644', type: 'blob', object: '686c16e4f019b734655a2576ce8b98749a9ffdb9', size: '764420', file: 'Screen Shot 2018-06-07 at 20.04.59.png' },
				{ mode: '100644', type: 'blob', object: '257cc5642cb1a054f08cc83f2d943e56fd3ebe99', size: '4', file: 'boom.txt' },
				{ mode: '100644', type: 'blob', object: '86dc360dd25f13fa50ffdc8259e9653921f4f2b7', size: '11', file: 'boomcaboom.txt' },
				{ mode: '100644', type: 'blob', object: 'a68b14060589b16d7ac75f67b905c918c03c06eb', size: '24', file: 'file.js' },
				{ mode: '100644', type: 'blob', object: 'f7bcfb05af46850d780f88c069edcd57481d822d', size: '201', file: 'file.md' },
				{ mode: '100644', type: 'blob', object: 'ab8b86114a051f6490f1ec5e3141b9a632fb46b5', size: '8', file: 'hello.js' },
				{ mode: '100644', type: 'blob', object: '257cc5642cb1a054f08cc83f2d943e56fd3ebe99', size: '4', file: 'what.js' },
				{ mode: '100644', type: 'blob', object: 'be859e3f412fa86513cd8bebe8189d1ea1a3e46d', size: '24', file: 'what.txt' },
				{ mode: '100644', type: 'blob', object: '56ec42c9dc6fcf4534788f0fe34b36e09f37d085', size: '261186', file: 'what.txt2' }
			]);
		});
	});

	suite('parseLsFiles', function () {
		test('sample', function () {
			const input = `100644 7a73a41bfdf76d6f793007240d80983a52f15f97 0	.vscode/settings.json
100644 1d487c1817262e4f20efbfa1d04c18f51b0046f6 0	Screen Shot 2018-06-01 at 14.48.05.png
100644 686c16e4f019b734655a2576ce8b98749a9ffdb9 0	Screen Shot 2018-06-07 at 20.04.59.png
100644 257cc5642cb1a054f08cc83f2d943e56fd3ebe99 0	boom.txt
100644 86dc360dd25f13fa50ffdc8259e9653921f4f2b7 0	boomcaboom.txt
100644 a68b14060589b16d7ac75f67b905c918c03c06eb 0	file.js
100644 f7bcfb05af46850d780f88c069edcd57481d822d 0	file.md
100644 ab8b86114a051f6490f1ec5e3141b9a632fb46b5 0	hello.js
100644 257cc5642cb1a054f08cc83f2d943e56fd3ebe99 0	what.js
100644 be859e3f412fa86513cd8bebe8189d1ea1a3e46d 0	what.txt
100644 56ec42c9dc6fcf4534788f0fe34b36e09f37d085 0	what.txt2`;

			const output = parseLsFiles(input);

			assert.deepStrictEqual(output, [
				{ mode: '100644', object: '7a73a41bfdf76d6f793007240d80983a52f15f97', stage: '0', file: '.vscode/settings.json' },
				{ mode: '100644', object: '1d487c1817262e4f20efbfa1d04c18f51b0046f6', stage: '0', file: 'Screen Shot 2018-06-01 at 14.48.05.png' },
				{ mode: '100644', object: '686c16e4f019b734655a2576ce8b98749a9ffdb9', stage: '0', file: 'Screen Shot 2018-06-07 at 20.04.59.png' },
				{ mode: '100644', object: '257cc5642cb1a054f08cc83f2d943e56fd3ebe99', stage: '0', file: 'boom.txt' },
				{ mode: '100644', object: '86dc360dd25f13fa50ffdc8259e9653921f4f2b7', stage: '0', file: 'boomcaboom.txt' },
				{ mode: '100644', object: 'a68b14060589b16d7ac75f67b905c918c03c06eb', stage: '0', file: 'file.js' },
				{ mode: '100644', object: 'f7bcfb05af46850d780f88c069edcd57481d822d', stage: '0', file: 'file.md' },
				{ mode: '100644', object: 'ab8b86114a051f6490f1ec5e3141b9a632fb46b5', stage: '0', file: 'hello.js' },
				{ mode: '100644', object: '257cc5642cb1a054f08cc83f2d943e56fd3ebe99', stage: '0', file: 'what.js' },
				{ mode: '100644', object: 'be859e3f412fa86513cd8bebe8189d1ea1a3e46d', stage: '0', file: 'what.txt' },
				{ mode: '100644', object: '56ec42c9dc6fcf4534788f0fe34b36e09f37d085', stage: '0', file: 'what.txt2' },
			]);
		});
	});

	suite('parseCoAuthors', () => {
		test('no co-authors', function () {
			assert.deepStrictEqual(parseCoAuthors('This is a commit message.'), []);
		});

		test('single co-author', function () {
			assert.deepStrictEqual(
				parseCoAuthors('Fix bug\n\nCo-authored-by: Jane Doe <jane@example.com>'),
				[{ name: 'Jane Doe', email: 'jane@example.com' }]
			);
		});

		test('multiple co-authors', function () {
			assert.deepStrictEqual(
				parseCoAuthors('Fix bug\n\nCo-authored-by: Jane Doe <jane@example.com>\nCo-authored-by: Bob Smith <bob@example.com>'),
				[
					{ name: 'Jane Doe', email: 'jane@example.com' },
					{ name: 'Bob Smith', email: 'bob@example.com' }
				]
			);
		});

		test('case insensitive', function () {
			assert.deepStrictEqual(
				parseCoAuthors('Fix bug\n\nco-authored-by: Jane Doe <jane@example.com>'),
				[{ name: 'Jane Doe', email: 'jane@example.com' }]
			);
		});

		test('AI co-author (Copilot)', function () {
			assert.deepStrictEqual(
				parseCoAuthors('Fix bug\n\nCo-authored-by: Copilot <copilot@github.com>'),
				[{ name: 'Copilot', email: 'copilot@github.com' }]
			);
		});

		test('mixed with other trailers', function () {
			assert.deepStrictEqual(
				parseCoAuthors('Fix bug\n\nSigned-off-by: Admin <admin@corp.com>\nCo-authored-by: Jane Doe <jane@example.com>'),
				[{ name: 'Jane Doe', email: 'jane@example.com' }]
			);
		});
	});

	suite('splitInChunks', () => {
		test('unit tests', function () {
			assert.deepStrictEqual(
				[...splitInChunks(['hello', 'there', 'cool', 'stuff'], 6)],
				[['hello'], ['there'], ['cool'], ['stuff']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['hello', 'there', 'cool', 'stuff'], 10)],
				[['hello', 'there'], ['cool', 'stuff']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['hello', 'there', 'cool', 'stuff'], 12)],
				[['hello', 'there'], ['cool', 'stuff']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['hello', 'there', 'cool', 'stuff'], 14)],
				[['hello', 'there', 'cool'], ['stuff']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['hello', 'there', 'cool', 'stuff'], 2000)],
				[['hello', 'there', 'cool', 'stuff']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 1)],
				[['0'], ['01'], ['012'], ['0'], ['01'], ['012'], ['0'], ['01'], ['012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 2)],
				[['0'], ['01'], ['012'], ['0'], ['01'], ['012'], ['0'], ['01'], ['012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 3)],
				[['0', '01'], ['012'], ['0', '01'], ['012'], ['0', '01'], ['012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 4)],
				[['0', '01'], ['012', '0'], ['01'], ['012', '0'], ['01'], ['012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 5)],
				[['0', '01'], ['012', '0'], ['01', '012'], ['0', '01'], ['012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 6)],
				[['0', '01', '012'], ['0', '01', '012'], ['0', '01', '012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 7)],
				[['0', '01', '012', '0'], ['01', '012', '0'], ['01', '012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 8)],
				[['0', '01', '012', '0'], ['01', '012', '0', '01'], ['012']]
			);

			assert.deepStrictEqual(
				[...splitInChunks(['0', '01', '012', '0', '01', '012', '0', '01', '012'], 9)],
				[['0', '01', '012', '0', '01'], ['012', '0', '01', '012']]
			);
		});
	});
});

suite('Git repository config and ref contracts', () => {
	let fixtureRoot: string;
	let sequence = 0;
	let gitPath: string;
	let gitVersion: string;
	let fixtureEnv: { [key: string]: string };

	suiteSetup(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-git-contract-'));
		gitPath = process.env['VSCODE_GIT_TEST_PATH'] || 'git';
		gitVersion = cp.execFileSync(gitPath, ['--version'], { encoding: 'utf8' }).trim().replace(/^git version /, '');
		const emptyConfig = path.join(fixtureRoot, 'global.config');
		await fs.writeFile(emptyConfig, '');
		fixtureEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: 'OctoCode isolated fixture', GIT_AUTHOR_EMAIL: 'octocode-fixture@example.invalid',
			GIT_COMMITTER_NAME: 'OctoCode isolated fixture', GIT_COMMITTER_EMAIL: 'octocode-fixture@example.invalid' };
	});

	suiteTeardown(async () => {
		assert.strictEqual(path.dirname(fixtureRoot), os.tmpdir());
		assert.ok(path.basename(fixtureRoot).startsWith('octocode-git-contract-'));
		await fs.rm(fixtureRoot, { recursive: true, force: true });
		assert.strictEqual(await fs.stat(fixtureRoot).then(() => true, () => false), false);
	});

	async function withRepository(body: (repo: Repository, root: string) => Promise<void>): Promise<void> {
		const root = path.join(fixtureRoot, String(++sequence));
		await fs.mkdir(root);
		const git = new Git({ gitPath, version: gitVersion, userAgent: 'OctoCode isolated test', env: fixtureEnv });
		await git.exec(root, ['init', '-b', 'main']);
		const logger: LogOutputChannel = {
			name: 'Isolated Git contract test', logLevel: 3,
			onDidChangeLogLevel: () => ({ dispose() { } }),
			trace() { }, debug() { }, info() { }, warn() { }, error() { },
			append() { }, appendLine() { }, replace() { }, clear() { },
			show() { }, hide() { }, dispose() { }
		};
		const repo = git.open(root, root, { path: path.join(root, '.git'), isBare: false }, logger);
		try {
			await body(repo, root);
		} finally {
			assert.strictEqual(path.dirname(root), fixtureRoot);
			await fs.rm(root, { recursive: true, force: true });
		}
	}

	for (const renames of ['copies', 'copy']) {
		test(`preserves native stash copies and diff URI paths with diff.renames=${renames}`, () => withRepository(async (repo, root) => {
			const original = path.join(root, 'aa-source.txt');
			const copied = path.join(root, 'ab-copy.txt');
			const following = path.join(root, 'zz-follow.txt');
			const baseline = Array.from({ length: 40 }, (_, index) => `Owned copy line ${index}\n`).join('');
			await fs.writeFile(original, baseline);
			await fs.writeFile(following, 'Owned following baseline\n');
			await repo.exec(['add', '--all']);
			await repo.exec(['commit', '-m', 'Owned copy baseline']);
			await fs.copyFile(original, copied);
			await fs.appendFile(original, 'Owned source modification\n');
			await fs.appendFile(following, 'Owned following modification\n');
			await repo.exec(['add', '--all']);
			await repo.exec(['stash', 'push', '-u', '-m', 'Owned copy contract']);
			await repo.exec(['config', 'diff.renames', renames]);
			const wire = await repo.exec(['stash', 'show', 'stash@{0}', '--name-status', '-z', '-u']);
			assert.strictEqual(wire.stdout, 'M\0aa-source.txt\0C100\0aa-source.txt\0ab-copy.txt\0M\0zz-follow.txt\0');
			const changes = await repo.showStash(0);
			assert.ok(changes);
			assert.deepStrictEqual(changes.map(change => ({
				file: path.relative(root, change.uri.fsPath),
				original: path.relative(root, change.originalUri.fsPath), status: change.status
			})), [
				{ file: 'aa-source.txt', original: 'aa-source.txt', status: Status.MODIFIED },
				{ file: 'ab-copy.txt', original: 'aa-source.txt', status: Status.INDEX_COPIED },
				{ file: 'zz-follow.txt', original: 'zz-follow.txt', status: Status.MODIFIED }
			]);
			const [stash] = await repo.getStashes();
			const resources = changes.map(change => toMultiFileDiffEditorUris(change, stash.parents[0], stash.hash));
			assert.ok(resources[1].originalUri && resources[1].modifiedUri);
			const oldSide = fromGitUri(resources[1].originalUri);
			const newSide = fromGitUri(resources[1].modifiedUri);
			assert.deepStrictEqual(oldSide, { path: changes[1].originalUri.fsPath, ref: stash.parents[0] });
			assert.deepStrictEqual(newSide, { path: changes[1].uri.fsPath, ref: stash.hash });
			assert.strictEqual((await repo.buffer(oldSide.ref, oldSide.path)).toString('utf8'), baseline);
			assert.strictEqual((await repo.buffer(newSide.ref, newSide.path)).toString('utf8'), baseline);
		}));
	}

	for (const missingBase of [false, true]) {
		test(`preserves explicit native index stages with ${missingBase ? 'add/add' : 'three-stage'} conflict`, () => withRepository(async (repo, root) => {
			const filename = 'shared-stage.txt';
			const file = path.join(root, filename);
			await repo.exec(['config', 'core.autocrlf', 'false']);
			await fs.writeFile(file, 'Owned stage baseline\n');
			await repo.exec(['add', '--', filename]);
			await repo.exec(['commit', '-m', 'Owned stage baseline']);
			const [ordinary] = await repo.lsfiles(file);
			assert.strictEqual(ordinary.stage, '0');
			assert.strictEqual((await repo.getObjectDetails('', file)).object, ordinary.object);
			assert.strictEqual((await repo.buffer('', file)).toString('utf8'), 'Owned stage baseline\n');
			if (missingBase) {
				await repo.exec(['rm', '--', filename]);
				await repo.exec(['commit', '-m', 'Owned common absent file']);
			}
			await repo.exec(['branch', 'owned-stage-other']);
			await fs.writeFile(file, 'Owned ours distinct bytes\n');
			await repo.exec(['add', '--', filename]);
			await repo.exec(['commit', '-m', 'Owned stage ours']);
			await repo.exec(['checkout', 'owned-stage-other']);
			await fs.writeFile(file, 'Owned stage theirs\n');
			await repo.exec(['add', '--', filename]);
			await repo.exec(['commit', '-m', 'Owned stage theirs']);
			await repo.exec(['checkout', 'main']);
			await assert.rejects(repo.exec(['merge', '--no-edit', 'owned-stage-other']),
				(err: unknown) => err instanceof GitError && err.exitCode === 1);
			const rows = await repo.lsfiles(file);
			assert.deepStrictEqual(rows.map(row => row.stage), missingBase ? ['2', '3'] : ['1', '2', '3']);
			for (const row of rows) {
				const selector = `:${row.stage}`;
				const native = await repo.exec(['cat-file', '-p', row.object]);
				const details = await repo.getObjectDetails(selector, file);
				assert.deepStrictEqual(details, { mode: row.mode, object: row.object, size: Buffer.byteLength(native.stdout) });
				assert.strictEqual((await repo.buffer(selector, file)).toString('utf8'), native.stdout);
			}
			if (missingBase) {
				await assert.rejects(repo.getObjectDetails(':1', file),
					(err: unknown) => err instanceof GitError && err.gitErrorCode === 'UnknownPath');
			}
			await assert.rejects(repo.getObjectDetails('', path.join(root, 'owned-absent.txt')),
				(err: unknown) => err instanceof GitError && err.gitErrorCode === 'UnknownPath');
		}));
	}

	for (const sample of [
		{ name: 'ordinary false', bare: false, section: 'core', properties: '\tbare = false\n' },
		{ name: 'bare true', bare: true, section: 'core', properties: '\tbare = true\n' },
		{ name: 'mixed section and key case', bare: true, section: 'CoRe', properties: '\tBaRe = true\n' },
		{ name: 'yes Boolean', bare: true, section: 'core', properties: '\tbare = yes\n' },
		{ name: 'valueless Boolean', bare: true, section: 'core', properties: '\tbare\n' },
		{ name: 'repeated scalar last true', bare: true, section: 'core', properties: '\tbare = false\n\tbare = true\n' }
	]) {
		test(`preserves native repository bareness for ${sample.name}`, () => withRepository(async (repo, root) => {
			const owned = sample.bare ? path.join(root, 'owned-bare.git') : root;
			if (sample.bare) {
				await repo.exec(['init', '--bare', owned]);
			}
			const dotPath = sample.bare ? owned : path.join(root, '.git');
			await fs.writeFile(path.join(dotPath, 'config'), `[${sample.section}]\n\trepositoryformatversion = 0\n${sample.properties}`);
			const git = new Git({ gitPath, version: gitVersion, userAgent: 'OctoCode isolated bare contract', env: fixtureEnv });
			const nativeBool = await git.exec(owned, ['config', '--bool', 'core.bare']);
			const nativeKind = await git.exec(owned, ['rev-parse', '--is-bare-repository']);
			assert.strictEqual(nativeBool.stdout.trim(), String(sample.bare));
			assert.strictEqual(nativeKind.stdout, nativeBool.stdout);
			assert.deepStrictEqual(await git.getRepositoryDotGit(owned), {
				isBare: sample.bare, path: path.normalize(dotPath), commonPath: undefined, superProjectPath: undefined
			});
		}));
	}

	for (const name of ['--list', '--delete']) {
		test(`preserves Git tag operand boundary for ${name}`, () => withRepository(async (repo, root) => {
			await fs.writeFile(path.join(root, 'owned.txt'), 'Owned tag operand baseline\n');
			await repo.exec(['add', '--', 'owned.txt']);
			await repo.exec(['commit', '-m', 'Owned tag operand baseline']);
			const ref = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
			await repo.exec(['tag', '--', ref]);
			await assert.rejects(repo.tag({ name, ref }));
			assert.strictEqual((await repo.exec(['rev-parse', `refs/tags/${ref}`])).stdout.trim(), ref);
		}));
	}

	test('preserves Git annotated tag operand options', () => withRepository(async (repo, root) => {
		await fs.writeFile(path.join(root, 'owned.txt'), 'Owned annotated baseline\n');
		await repo.exec(['add', '--', 'owned.txt']);
		await repo.exec(['commit', '-m', 'Owned annotated baseline']);
		const ref = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
		await repo.tag({ name: 'owned-annotated', message: 'Owned annotation', ref });
		assert.strictEqual((await repo.exec(['cat-file', '-t', 'refs/tags/owned-annotated'])).stdout.trim(), 'tag');
		assert.strictEqual((await repo.exec(['for-each-ref', '--format=%(contents)', 'refs/tags/owned-annotated'])).stdout.trim(), 'Owned annotation');
	}));

	test('preserves Git worktree literal option-like path', () => withRepository(async (repo, root) => {
		await fs.writeFile(path.join(root, 'owned.txt'), 'Owned worktree operand baseline\n');
		await repo.exec(['add', '--', 'owned.txt']);
		await repo.exec(['commit', '-m', 'Owned worktree operand baseline']);
		await repo.addWorktree({ path: '--lock', commitish: 'HEAD', branch: 'owned-operand-feature', noTrack: true });
		const destination = path.join(root, '--lock');
		assert.strictEqual(await fs.stat(destination).then(() => true, () => false), true);
		const worktrees = (await repo.exec(['worktree', 'list', '--porcelain'])).stdout;
		assert.strictEqual(/^locked(?: |$)/m.test(worktrees), false);
		assert.ok(worktrees.includes('branch refs/heads/owned-operand-feature'));
		await assert.rejects(repo.exec(['config', '--get', 'branch.owned-operand-feature.remote']));
	}));

	for (const typeChanged of [false, true]) {
		test(`preserves native stash ${typeChanged ? 'type change before modification' : 'ordinary modifications'}`, () => withRepository(async (repo, root) => {
			await fs.writeFile(path.join(root, 'a-type'), 'before a\n');
			await fs.writeFile(path.join(root, 'b-after'), 'before b\n');
			await repo.exec(['config', 'core.symlinks', 'false']);
			await repo.exec(['add', '--', 'a-type', 'b-after']);
			await repo.exec(['commit', '-m', 'Owned stash baseline']);
			if (typeChanged) {
				const object = await repo.hashObject('b-after');
				await repo.exec(['update-index', '--add', '--cacheinfo', `120000,${object},a-type`]);
				assert.match((await repo.exec(['ls-files', '--stage', '--', 'a-type'])).stdout, /^120000 /);
			} else {
				await fs.writeFile(path.join(root, 'a-type'), 'after a\n');
			}
			await fs.writeFile(path.join(root, 'b-after'), 'after b\n');
			await repo.exec(['stash', 'push', '-m', 'Owned stash descriptor']);
			const wire = await repo.exec(['stash', 'show', 'stash@{0}', '--name-status', '-z', '-u']);
			assert.strictEqual(wire.stdout, `${typeChanged ? 'T' : 'M'}\0a-type\0M\0b-after\0`);
			const changes = await repo.showStash(0);
			assert.deepStrictEqual(changes?.map(change => ({ file: path.relative(root, change.uri.fsPath), status: change.status })), [
				{ file: 'a-type', status: typeChanged ? Status.TYPE_CHANGED : Status.MODIFIED },
				{ file: 'b-after', status: Status.MODIFIED }
			]);
		}));
	}

	for (const filename of ['plain.txt', 'interior space.txt', '本地 空间.txt']) {
		test(`restores native tree and index filename ${filename}`, () => withRepository(async (repo, root) => {
			const file = path.join(root, filename);
			const content = `Owned filename ${filename}\n`;
			await fs.writeFile(file, content);
			await repo.exec(['config', 'core.quotepath', 'true']);
			await repo.exec(['add', '--', filename]);
			await repo.exec(['commit', '-m', 'Owned filename baseline']);
			const tree = await repo.lstree('HEAD', filename);
			const index = await repo.lsfiles(file);
			assert.deepStrictEqual(tree.map(row => row.file), [filename]);
			assert.deepStrictEqual(index.map(row => row.file), [filename]);
			const request = path.join(root, filename.replace(/\.txt$/, '.TXT'));
			if (process.platform === 'win32') {
				await assert.rejects(repo.buffer('HEAD', request), (err: unknown) => err instanceof GitError && err.gitErrorCode === 'WrongCase' && err.exitCode === 128);
			}
			for (const ref of ['HEAD', '']) {
				const recovered = await repo.getGitFilePath(ref, request);
				assert.strictEqual(recovered, file);
				assert.strictEqual((await repo.buffer(ref, recovered)).toString('utf8'), content);
				assert.strictEqual(await fs.readFile(recovered, 'utf8'), content);
			}
		}));
	}

	const nulPathnames = [' leading.txt', 'trailing.txt ', 'embedded\ttab.txt', 'line\nbreak.txt', '本地 空间.txt'];
	test('preserves NUL tree record pathname bytes including whitespace', () => {
		const object = 'a'.repeat(40);
		const raw = nulPathnames.map(file => `100644 blob ${object}      12\t${file}\0`).join('');
		assert.deepStrictEqual(parseLsTree(raw, '\0'), nulPathnames.map(file => ({ mode: '100644', type: 'blob', object, size: '12', file })));
	});
	test('preserves NUL index record pathname bytes including whitespace', () => {
		const object = 'b'.repeat(40);
		const raw = nulPathnames.map(file => `100644 ${object} 0\t${file}\0`).join('');
		assert.deepStrictEqual(parseLsFiles(raw, '\0'), nulPathnames.map(file => ({ mode: '100644', object, stage: '0', file })));
	});

	for (const sample of [
		{ label: 'default maximum', options: undefined, commits: 35, expected: 32 },
		{ label: 'range-only completeness beyond default maximum', options: { range: 'HEAD' }, commits: 35, expected: 35 },
		{ label: 'ordinary explicit maximum', options: { maxEntries: 2 }, commits: 5, expected: 2 },
		{ label: 'range with explicit maximum', options: { range: 'HEAD', maxEntries: 2 }, commits: 5, expected: 2 },
		{ label: 'range with explicit zero maximum', options: { range: 'HEAD', maxEntries: 0 }, commits: 5, expected: 0 }
	]) {
		test(`honors native log ${sample.label}`, () => withRepository(async repo => {
			for (let index = 0; index < sample.commits; index++) {
				await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', `Owned log entry ${index}`]);
			}
			const commits = await repo.log(sample.options);
			assert.strictEqual(commits.length, sample.expected);
			const native = await repo.exec(['log', '--format=%H', `-n${sample.expected}`, 'HEAD']);
			const hashes = native.stdout.trim() ? native.stdout.trim().split(/\r?\n/) : [];
			assert.deepStrictEqual(commits.map(commit => commit.hash), hashes);
		}));
	}

	for (const sample of [
		{ label: 'heads-only', options: { heads: true }, names: ['main', 'owned-other'] },
		{ label: 'tags-only', options: { tags: true }, names: ['owned-tag'] },
		{ label: 'default', options: undefined, names: ['main', 'owned-other', 'owned-tag'] }
	]) {
		test(`returns native remote ref fields for ${sample.label}`, () => withRepository(async (repo, root) => {
			await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned remote refs baseline']);
			await repo.exec(['branch', 'owned-other']);
			await repo.exec(['-c', 'tag.gpgsign=false', 'tag', 'owned-tag']);
			const commit = (await repo.exec(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
			const refs = await repo.getRemoteRefs(root, sample.options);
			assert.deepStrictEqual(refs, sample.names.map(name => ({
				name, commit, type: name === 'owned-tag' ? RefType.Tag : RefType.Head
			})));
		}));
	}

	test('honors native revision and config contract: empty revision range', () => withRepository(async repo => {
		for (let index = 0; index < 2; index++) {
			await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', `Owned range ${index}`]);
		}
		const nonempty = await repo.exec(['rev-list', 'HEAD~1..HEAD']);
		assert.strictEqual(nonempty.stderr, '');
		assert.deepStrictEqual(await repo.revList('HEAD~1', 'HEAD'), nonempty.stdout.trim().split('\n'));
		const empty = await repo.exec(['rev-list', 'HEAD..HEAD']);
		assert.strictEqual(empty.exitCode, 0);
		assert.strictEqual(empty.stdout, '');
		assert.strictEqual(empty.stderr, '');
		assert.deepStrictEqual(await repo.revList('HEAD', 'HEAD'), []);
	}));

	test('preserves successful native revision warnings', () => withRepository(async repo => {
		for (let index = 0; index < 2; index++) {
			await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', `Owned warning range ${index}`]);
		}
		const head = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
		await repo.exec(['branch', 'owned-warning-branch', head]);
		await repo.tag({ name: 'owned-warning-branch', ref: head });
		const native = await repo.exec(['rev-list', 'HEAD~1..owned-warning-branch']);
		assert.strictEqual(native.exitCode, 0);
		assert.match(native.stderr, /refname 'owned-warning-branch' is ambiguous/);
		assert.strictEqual(native.stdout.trim(), head);
		assert.deepStrictEqual(await repo.revList('HEAD~1', 'owned-warning-branch'), [head]);
	}));

	test('preserves failed native revision errors', () => withRepository(async repo => {
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned fatal revision control']);
		await assert.rejects(repo.revList('owned-does-not-exist', 'HEAD'), (error: unknown) => {
			assert.ok(error instanceof GitError);
			assert.strictEqual(error.exitCode, 128);
			assert.ok(typeof error.stderr === 'string' && error.stderr.length > 0);
			return true;
		});
	}));

	test('preserves successful native default branch trace diagnostics', () => withRepository(async (repo, root) => {
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned default branch trace control']);
		const head = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
		await repo.exec(['update-ref', 'refs/remotes/origin/main', head]);
		await repo.exec(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
		const tracedGit = new Git({ gitPath, version: gitVersion, userAgent: 'OctoCode owned trace contract', env: { ...fixtureEnv, GIT_TRACE: '1' } });
		const native = await tracedGit.exec(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
		assert.strictEqual(native.exitCode, 0);
		assert.strictEqual(native.stdout.trim(), 'origin/main');
		assert.match(native.stderr, /trace: built-in: git symbolic-ref/);
		const logger: LogOutputChannel = {
			name: 'Owned trace contract', logLevel: 3, onDidChangeLogLevel: () => ({ dispose() { } }),
			trace() { }, debug() { }, info() { }, warn() { }, error() { }, append() { }, appendLine() { },
			replace() { }, clear() { }, show() { }, hide() { }, dispose() { }
		};
		const traced = tracedGit.open(root, root, { path: path.join(root, '.git'), isBare: false }, logger);
		const branch = await traced.getDefaultBranch('origin');
		assert.deepStrictEqual({ name: branch.name, remote: branch.remote, commit: branch.commit }, { name: 'main', remote: 'origin', commit: head });
	}));

	test('preserves failed native default branch errors', () => withRepository(async repo => {
		await assert.rejects(repo.getDefaultBranch('owned-absent'),
			(error: unknown) => error instanceof GitError && error.exitCode !== 0 && error.gitCommand === 'symbolic-ref' && !!error.stderr);
	}));

	async function seedOwnedCherryPick(repo: Repository, root: string): Promise<string> {
		const hooks = path.join(root, 'owned-empty-hooks');
		await fs.mkdir(hooks);
		await repo.exec(['config', '--local', 'core.hooksPath', hooks]);
		await repo.exec(['config', '--local', 'commit.gpgsign', 'false']);
		await fs.writeFile(path.join(root, 'conflict.txt'), 'base\n');
		await repo.exec(['add', '--', 'conflict.txt']);
		await repo.exec(['commit', '-m', 'Owned cherry-pick base']);
		return (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
	}

	for (const conflict of [false, true]) {
		test(`preserves native cherry-pick ${conflict ? 'real conflict' : 'clean commit'}`, () => withRepository(async (repo, root) => {
			await seedOwnedCherryPick(repo, root);
			await repo.exec(['checkout', '-b', 'owned-topic']);
			await fs.writeFile(path.join(root, conflict ? 'conflict.txt' : 'new.txt'), 'Owned topic\n');
			await repo.exec(['add', '--all']);
			await repo.exec(['commit', '-m', 'Owned cherry-pick topic']);
			const topic = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
			await repo.exec(['checkout', 'main']);
			if (conflict) {
				await fs.writeFile(path.join(root, 'conflict.txt'), 'Owned main\n');
				await repo.exec(['add', '--', 'conflict.txt']);
				await repo.exec(['commit', '-m', 'Owned divergent main']);
			}
			const before = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
			if (!conflict) {
				await repo.cherryPick(topic);
				assert.strictEqual(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'Owned topic\n');
				assert.notStrictEqual((await repo.exec(['rev-parse', 'HEAD'])).stdout.trim(), before);
				assert.strictEqual((await repo.exec(['status', '--porcelain=v1', '-z'])).stdout, '');
				assert.strictEqual(await fs.stat(path.join(root, '.git', 'CHERRY_PICK_HEAD')).then(() => true, () => false), false);
			} else {
				try {
					await assert.rejects(repo.cherryPick(topic), (error: unknown) => {
						assert.ok(error instanceof GitError);
						assert.strictEqual(error.gitErrorCode, GitErrorCodes.CherryPickConflict);
						return true;
					});
					assert.ok((await repo.exec(['ls-files', '--unmerged', '-z'])).stdout.length > 0);
					assert.strictEqual((await fs.readFile(path.join(root, '.git', 'CHERRY_PICK_HEAD'), 'utf8')).trim(), topic);
				} finally {
					await repo.cherryPickAbort();
					assert.strictEqual((await repo.exec(['rev-parse', 'HEAD'])).stdout.trim(), before);
					assert.strictEqual((await repo.exec(['status', '--porcelain=v1', '-z'])).stdout, '');
				}
			}
		}));
	}

	test('preserves native cherry-pick non-conflict errors', () => withRepository(async (repo, root) => {
		const before = await seedOwnedCherryPick(repo, root);
		const missing = 'f'.repeat(40);
		await assert.rejects(repo.exec(['cat-file', '-e', `${missing}^{commit}`]), (error: unknown) => error instanceof GitError);
		let nativeError: GitError | undefined;
		try {
			await repo.exec(['cherry-pick', missing]);
			assert.fail('owned missing commit unexpectedly exists');
		} catch (error) {
			assert.ok(error instanceof GitError);
			assert.ok(typeof error.stderr === 'string' && error.stderr.includes('bad object'));
			nativeError = error;
		}
		assert.ok(nativeError);
		const baseline = nativeError;
		assert.strictEqual((await repo.exec(['rev-parse', 'HEAD'])).stdout.trim(), before);
		assert.strictEqual((await repo.exec(['status', '--porcelain=v1', '-z'])).stdout, '');
		await assert.rejects(repo.cherryPick(missing), (error: unknown) => {
			assert.ok(error instanceof GitError);
			assert.ok(typeof error.exitCode === 'number' && error.exitCode !== 0);
			assert.strictEqual(error.gitCommand, 'cherry-pick');
			assert.deepStrictEqual(error.gitArgs, ['cherry-pick', missing]);
			assert.strictEqual(error.stderr, baseline.stderr);
			assert.notStrictEqual(error.gitErrorCode, GitErrorCodes.CherryPickConflict);
			assert.strictEqual(error.gitErrorCode, baseline.gitErrorCode);
			return true;
		});
		assert.strictEqual((await repo.exec(['rev-parse', 'HEAD'])).stdout.trim(), before);
		assert.strictEqual((await repo.exec(['status', '--porcelain=v1', '-z'])).stdout, '');
		assert.strictEqual((await repo.exec(['ls-files', '--unmerged', '-z'])).stdout, '');
		assert.strictEqual(await fs.stat(path.join(root, '.git', 'CHERRY_PICK_HEAD')).then(() => true, () => false), false);
	}));

	test('honors native revision and config contract: symbolic and packed refs', () => withRepository(async (repo, root) => {
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned symbolic reference']);
		const commit = (await repo.exec(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
		await repo.exec(['update-ref', 'refs/remotes/owned/plain', commit]);
		await repo.exec(['update-ref', 'refs/remotes/owned/target', commit]);
		await repo.exec(['symbolic-ref', 'refs/remotes/owned/alias', 'refs/remotes/owned/target']);
		assert.strictEqual(await repo.revParse('refs/remotes/owned/plain'), commit);
		assert.strictEqual(await fs.readFile(path.join(root, '.git', 'refs/remotes/owned/alias'), 'utf8'), 'ref: refs/remotes/owned/target\n');
		const native = (await repo.exec(['rev-parse', '--verify', 'refs/remotes/owned/alias'])).stdout.trim();
		assert.strictEqual(await repo.revParse('refs/remotes/owned/alias'), native);
		await repo.exec(['pack-refs', '--all', '--prune']);
		assert.strictEqual(await fs.stat(path.join(root, '.git', 'refs/remotes/owned/plain')).then(() => true, () => false), false);
		assert.strictEqual(await repo.revParse('refs/remotes/owned/plain'), commit);
	}));

	test('honors native revision and config contract: tracking symbolic upstream', () => withRepository(async (repo, root) => {
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned upstream reference']);
		const commit = (await repo.exec(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
		await repo.exec(['update-ref', 'refs/remotes/owned/target', commit]);
		await repo.exec(['symbolic-ref', 'refs/remotes/owned/alias', 'refs/remotes/owned/target']);
		await repo.exec(['config', '--local', 'remote.owned.url', root]);
		await repo.exec(['config', '--local', 'remote.owned.fetch', '+refs/heads/*:refs/remotes/owned/*']);
		await repo.exec(['config', '--local', 'branch.main.remote', 'owned']);
		await repo.exec(['config', '--local', 'branch.main.merge', 'refs/heads/alias']);
		const branch = await repo.getBranch('main');
		assert.strictEqual(branch.upstream?.remote, 'owned');
		assert.strictEqual(branch.upstream?.name, 'alias');
		const native = (await repo.exec(['rev-parse', '--verify', 'refs/remotes/owned/alias'])).stdout.trim();
		assert.strictEqual((await repo.getHEADRef())?.upstream?.commit, native);
	}));

	test('honors native revision and config contract: legal comma reference names', () => withRepository(async repo => {
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned comma references']);
		const ordinary = (await repo.exec(['show', '-s', '--decorate=full', '--format=%D', 'HEAD', '--'])).stdout.trim();
		assert.deepStrictEqual((await repo.getCommit('HEAD')).refNames, ordinary.split(', '));
		await repo.exec(['check-ref-format', 'refs/heads/owned,left']);
		await repo.exec(['check-ref-format', 'refs/tags/owned,tag']);
		await repo.exec(['branch', 'owned,left']);
		await repo.exec(['-c', 'tag.gpgsign=false', 'tag', 'owned,tag']);
		const nativeRefs = (await repo.exec(['for-each-ref', '--format=%(refname)', '--points-at', 'HEAD'])).stdout.trim().split('\n');
		assert.ok(nativeRefs.includes('refs/heads/owned,left'));
		assert.ok(nativeRefs.includes('refs/tags/owned,tag'));
		const commit = await repo.getCommit('HEAD');
		assert.ok(commit.refNames.includes('refs/heads/owned,left'));
		assert.ok(commit.refNames.includes('tag: refs/tags/owned,tag'));
	}));

	for (const sample of [
		{ label: 'plain CRLF control', value: 'https://host.invalid/owned.git' },
		{ label: 'quoted literal markers control', value: '"https://host.invalid/owned.git#literal;segment"' },
		{ label: 'unquoted hash comment', value: 'https://host.invalid/owned.git # owned comment' },
		{ label: 'quoted hash comment', value: '"https://host.invalid/owned.git" # owned comment' },
		{ label: 'unquoted semicolon comment', value: 'https://host.invalid/owned.git ; owned comment' },
		{ label: 'quoted semicolon comment', value: '"https://host.invalid/owned.git" ; owned comment' }
	]) {
		test(`honors native revision and config contract: remote ${sample.label}`, () => withRepository(async (repo, root) => {
			await fs.appendFile(path.join(root, '.git', 'config'), `\r\n[remote "owned-parse"]\r\n\turl = ${sample.value}\r\n`);
			const native = (await repo.exec(['config', '--local', '--get', 'remote.owned-parse.url'])).stdout.replace(/\n$/, '');
			const remote = (await repo.getRemotes()).find(remote => remote.name === 'owned-parse');
			assert.deepStrictEqual([remote?.fetchUrl, remote?.pushUrl, remote?.isReadOnly], [native, native, false]);
		}));
	}

	for (const sample of [
		{ label: 'quoted inline comment', value: '"https://host.invalid/owned.git" # owned comment' },
		{ label: 'quoted literal markers control', value: '"https://host.invalid/owned.git#literal;segment"' }
	]) {
		test(`honors native revision and config contract: module ${sample.label}`, () => withRepository(async (repo, root) => {
			const modules = path.join(root, '.gitmodules');
			await fs.writeFile(modules, `[submodule "owned-module"]\r\n\tpath = owned-module\r\n\turl = ${sample.value}\r\n`);
			const native = (await repo.exec(['config', '--file', modules, '--get', 'submodule.owned-module.url'])).stdout.replace(/\n$/, '');
			assert.deepStrictEqual(await repo.getSubmodules(), [{ name: 'owned-module', path: 'owned-module', url: native }]);
		}));
	}

	test('persists, reads and removes an ordinary config value', () => withRepository(async repo => {
		await repo.config('add', 'local', 'octoaudit.ordinary', 'false');
		assert.strictEqual(await repo.config('get', 'local', 'octoaudit.ordinary'), 'false');
		await repo.config('unset', 'local', 'octoaudit.ordinary');
		assert.strictEqual(await repo.config('get', 'local', 'octoaudit.ordinary'), '');
	}));

	test('persists an empty string instead of dropping the value argument', () => withRepository(async repo => {
		await repo.config('add', 'local', 'octoaudit.empty', '');
		assert.strictEqual((await repo.exec(['config', '--get', 'octoaudit.empty'])).stdout, '\n');
		await repo.config('unset', 'local', 'octoaudit.empty');
		assert.strictEqual(await repo.config('get', 'local', 'octoaudit.empty'), '');
	}));

	test('keeps an absent optional config read empty', () => withRepository(async repo => {
		assert.strictEqual(await repo.config('get', 'local', 'octoaudit.absent'), '');
	}));

	test('keeps removing an absent optional config key idempotent', () => withRepository(async repo => {
		assert.strictEqual(await repo.config('unset', 'local', 'octoaudit.absent'), '');
	}));

	for (const operation of ['add', 'unset']) {
		test(`rejects ${operation} when the actual config lock prevents persistence`, () => withRepository(async (repo, root) => {
			await repo.exec(['config', '--add', 'octoaudit.locked', 'before']);
			const config = path.join(root, '.git', 'config');
			const before = await fs.readFile(config);
			await fs.writeFile(path.join(root, '.git', 'config.lock'), 'owned fixture lock', { flag: 'wx' });
			await assert.rejects(repo.config(operation, 'local', 'octoaudit.locked', operation === 'add' ? 'after' : null),
				(err: unknown) => err instanceof GitError && err.exitCode !== 0 && !!err.stderr);
			assert.deepStrictEqual(await fs.readFile(config), before);
		}));
	}

	test('rejects a malformed config read instead of reporting a missing key', () => withRepository(async (repo, root) => {
		await fs.appendFile(path.join(root, '.git', 'config'), '\n[broken\n');
		await assert.rejects(repo.config('get', 'local', 'octoaudit.absent'),
			(err: unknown) => err instanceof GitError && err.exitCode !== 0 && !!err.stderr);
	}));

	test('returns no fabricated entry for an empty config file', () => withRepository(async repo => {
		assert.deepStrictEqual(await repo.getConfigs('global'), []);
	}));

	test('preserves multiline, equals signs, whitespace, empty and repeated config values', () => withRepository(async repo => {
		const expected = [
			{ key: 'octoaudit.multiline', value: 'first\nsecond\r\nthird' },
			{ key: 'octoaudit.equals', value: 'a=b=c' },
			{ key: 'octoaudit.space', value: '  leading and trailing  ' },
			{ key: 'octoaudit.unicode', value: '中文 Привет' },
			{ key: 'octoaudit.empty', value: '' },
			{ key: 'octoaudit.repeat', value: 'one' },
			{ key: 'octoaudit.repeat', value: 'two' }
		];
		for (const item of expected) {
			await repo.exec(['config', '--add', item.key, item.value]);
		}
		assert.deepStrictEqual((await repo.getConfigs('local')).filter(item => item.key.startsWith('octoaudit.')), expected);
	}));

	test('preserves a legal bare boolean config key', () => withRepository(async (repo, root) => {
		await fs.appendFile(path.join(root, '.git', 'config'), '\n[octoaudit]\n\tbare\n');
		assert.deepStrictEqual((await repo.getConfigs('local')).filter(item => item.key.startsWith('octoaudit.')),
			[{ key: 'octoaudit.bare', value: '' }]);
	}));

	test('uses the peeled commit hash for annotated tag details', () => withRepository(async repo => {
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'root fixture']);
		const parent = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
		await repo.exec(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'second fixture']);
		const head = (await repo.exec(['rev-parse', 'HEAD'])).stdout.trim();
		await repo.exec(['-c', 'tag.gpgsign=false', 'tag', '-a', 'annotated', '-m', 'fixture tag']);
		await repo.exec(['tag', 'lightweight']);
		const tag = (await repo.exec(['rev-parse', 'annotated'])).stdout.trim();
		assert.notStrictEqual(tag, head);
		const refs = await repo.getRefs({ includeCommitDetails: true });
		for (const name of ['main', 'lightweight', 'annotated']) {
			const ref = refs.find(ref => ref.name === name)!;
			assert.strictEqual(ref.commit, head, name);
			assert.strictEqual(ref.commitDetails?.hash, head, name);
			assert.deepStrictEqual(ref.commitDetails?.parents, [parent], name);
			assert.strictEqual(ref.commitDetails?.message, 'second fixture', name);
		}
	}));
});

suite('Git linked worktree metadata contracts', () => {
	let fixtureRoot: string;
	let sequence = 0;
	let gitPath: string;
	let gitVersion: string;
	let fixtureEnv: { [key: string]: string };
	const logger: LogOutputChannel = {
		name: 'Owned worktree path fixture', logLevel: 3,
		onDidChangeLogLevel: () => ({ dispose() { } }),
		trace() { }, debug() { }, info() { }, warn() { }, error() { },
		append() { }, appendLine() { }, replace() { }, clear() { }, show() { }, hide() { }, dispose() { }
	};
	suiteSetup(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-worktree-path-'));
		gitPath = process.env.VSCODE_GIT_TEST_PATH!;
		assert.ok(gitPath);
		gitVersion = cp.execFileSync(gitPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim().replace(/^git version /, '');
		const emptyConfig = path.join(fixtureRoot, 'empty-global-config');
		await fs.writeFile(emptyConfig, '');
		fixtureEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: 'OctoCode owned fixture', GIT_AUTHOR_EMAIL: 'octocode-fixture@example.invalid',
			GIT_COMMITTER_NAME: 'OctoCode owned fixture', GIT_COMMITTER_EMAIL: 'octocode-fixture@example.invalid' };
	});
	suiteTeardown(async () => {
		assert.strictEqual(path.dirname(fixtureRoot), os.tmpdir());
		assert.ok(path.basename(fixtureRoot).startsWith('octocode-worktree-path-'));
		await fs.rm(fixtureRoot, { recursive: true, force: true });
		assert.strictEqual(await fs.stat(fixtureRoot).then(() => true, () => false), false);
	});
	async function withWorktree(kind: 'ordinary' | 'linked' | 'separate', ancestor: string,
		body: (repo: Repository, git: Git, worktree: string, main: string) => Promise<void>): Promise<void> {
		const owned = path.join(fixtureRoot, String(++sequence));
		const main = path.join(owned, 'main');
		await fs.mkdir(main, { recursive: true });
		const git = new Git({ gitPath, version: gitVersion, userAgent: 'OctoCode owned test', env: fixtureEnv });
		let repo: Repository | undefined;
		try {
			const init = ['init', '-b', 'main'];
			if (kind === 'separate') { init.push('--separate-git-dir', path.join(owned, 'metadata')); }
			await git.exec(main, init);
			await git.exec(main, ['commit', '--allow-empty', '-m', 'Owned initial commit']);
			await git.exec(main, ['checkout', '-b', 'owned-feature']);
			await fs.writeFile(path.join(main, 'owned-feature.txt'), 'Owned feature content\n');
			await git.exec(main, ['add', 'owned-feature.txt']);
			await git.exec(main, ['commit', '-m', 'Owned feature commit']);
			await git.exec(main, ['checkout', 'main']);
			let worktree = main;
			if (kind === 'linked') {
				worktree = path.join(owned, ancestor, 'nested', 'worktree');
				await git.exec(main, ['worktree', 'add', '-b', 'owned-linked', worktree, 'main']);
				assert.strictEqual((await fs.stat(path.join(worktree, '.git'))).isFile(), true);
			}
			const dotGit = await git.getRepositoryDotGit(worktree);
			assert.strictEqual(path.isAbsolute(dotGit.path), true);
			repo = git.open(worktree, worktree, dotGit, logger);
			await body(repo, git, worktree, main);
		} finally {
			assert.strictEqual(path.dirname(owned), fixtureRoot);
			assert.ok(path.relative(fixtureRoot, owned) && !path.relative(fixtureRoot, owned).startsWith('..'));
			await fs.rm(owned, { recursive: true, force: true });
			assert.strictEqual(await fs.stat(owned).then(() => true, () => false), false);
		}
	}
	for (const kind of ['ordinary', 'linked', 'separate'] as const) {
		test(`reports actual main worktree checkout path in ${kind} repository`, () => withWorktree(kind, 'ordinary-parent', async (repo, git, worktree, main) => {
			const root = (await git.exec(worktree, ['rev-parse', '--show-toplevel'])).stdout.trimStart().replace(/[\r\n]+$/, '');
			assert.strictEqual(path.normalize(root), path.normalize(worktree));
			const actual = await repo.getWorktrees();
			const mainWorktree = actual.find(item => item.main);
			assert.ok(mainWorktree);
			assert.strictEqual(path.normalize(mainWorktree.path), path.normalize(main));
			assert.strictEqual(mainWorktree.name, path.basename(main));
			assert.strictEqual(actual.filter(item => item.main).length, 1);
			if (kind === 'linked') {
				assert.ok(actual.some(item => !item.main && path.normalize(item.path) === path.normalize(worktree)));
			}
		}));
		test(`reads actual Git squash message in ${kind} repository`, () => withWorktree(kind, 'ordinary-parent', async (repo, git, worktree) => {
			await git.exec(worktree, ['merge', '--squash', 'owned-feature']);
			const generatedPath = (await git.exec(worktree, ['rev-parse', '--git-path', 'SQUASH_MSG'])).stdout.trim();
			const generated = await fs.readFile(path.resolve(worktree, generatedPath), 'utf8');
			assert.ok(generated.includes('Owned feature commit'));
			const message = await repo.getSquashMessage();
			assert.ok(message?.includes('Owned feature commit'), `Actual Git SQUASH_MSG exists for ${kind}; returned ${JSON.stringify(message)}`);
		}));
		test(`reads actual Git pending merge message in ${kind} repository`, () => withWorktree(kind, 'ordinary-parent', async (repo, git, worktree) => {
			await git.exec(worktree, ['merge', '--no-ff', '--no-commit', 'owned-feature']);
			const generatedPath = (await git.exec(worktree, ['rev-parse', '--git-path', 'MERGE_MSG'])).stdout.trim();
			const generated = await fs.readFile(path.resolve(worktree, generatedPath), 'utf8');
			assert.ok(generated.includes('owned-feature'));
			const message = await repo.getMergeMessage();
			assert.ok(message?.includes('owned-feature'), `Actual Git MERGE_MSG exists for ${kind}; returned ${JSON.stringify(message)}`);
		}));
	}
	for (const ancestor of ['ordinary-parent', '.git-owned-parent', 'xgit-owned-parent']) {
		test(`preserves actual linked worktree path under ${ancestor}`, () => withWorktree('linked', ancestor, async (repo, git, worktree, main) => {
			const actual = await repo.getWorktrees();
			const linked = actual.find(item => !item.main);
			const porcelain = (await git.exec(main, ['worktree', 'list', '--porcelain'])).stdout;
			assert.ok(porcelain.replace(/\\/g, '/').includes(worktree.replace(/\\/g, '/')));
			assert.ok(linked);
			assert.strictEqual(path.normalize(linked.path), path.normalize(worktree));
		}));
	}
	for (const [target, token] of [['main', 'ENOTDIR'], ['linked', 'ENOENT']] as const) {
		test(`propagates worktree read errors mentioning ${token}`, () => withWorktree('linked', token, async (repo, git, worktree, main) => {
			const dotGit = await git.getRepositoryDotGit(target === 'main' ? main : worktree);
			const headPath = path.join(dotGit.path, 'HEAD');
			const busy = Object.assign(new Error(`EBUSY: locked metadata in directory named ${token}`), { code: 'EBUSY' });
			const readFile = fs.readFile;
			try {
				fs.readFile = ((...args: Parameters<typeof fs.readFile>) => {
					if (path.normalize(String(args[0])) === path.normalize(headPath)) {
						return Promise.reject(busy);
					}
					return Reflect.apply(readFile, fs, args);
				}) as typeof fs.readFile;
				await assert.rejects(repo.getWorktrees(), (actual: unknown) => actual === busy);
			} finally {
				fs.readFile = readFile;
			}
		}));
	}
	test('skips a linked worktree whose HEAD actually disappeared', () => withWorktree('linked', 'ordinary-parent', async (repo, git, worktree, main) => {
		const dotGit = await git.getRepositoryDotGit(worktree);
		await fs.unlink(path.join(dotGit.path, 'HEAD'));
		const actual = await repo.getWorktrees();
		assert.strictEqual(actual.length, 1);
		assert.strictEqual(actual[0].main, true);
		assert.strictEqual(path.normalize(actual[0].path), path.normalize(main));
	}));
});

suite('Git command privacy and operand error contracts', () => {
	let fixtureRoot: string;
	let sequence = 0;
	let gitPath: string;
	let gitVersion: string;
	let fixtureEnv: { [key: string]: string };
	const logger: LogOutputChannel = {
		name: 'Owned Git command fixture', logLevel: 3,
		onDidChangeLogLevel: () => ({ dispose() { } }),
		trace() { }, debug() { }, info() { }, warn() { }, error() { },
		append() { }, appendLine() { }, replace() { }, clear() { }, show() { }, hide() { }, dispose() { }
	};
	suiteSetup(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-git-command-'));
		gitPath = process.env.VSCODE_GIT_TEST_PATH!;
		assert.ok(gitPath);
		gitVersion = cp.execFileSync(gitPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim().replace(/^git version /, '');
		const emptyConfig = path.join(fixtureRoot, 'empty-global-config');
		await fs.writeFile(emptyConfig, '');
		fixtureEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: 'Owned Git fixture', GIT_AUTHOR_EMAIL: 'owned-fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Owned Git fixture', GIT_COMMITTER_EMAIL: 'owned-fixture@example.invalid',
			GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_TRACE2: '0',
			HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
			http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*' };
	});
	suiteTeardown(async () => {
		assert.strictEqual(path.dirname(fixtureRoot), os.tmpdir());
		assert.ok(path.basename(fixtureRoot).startsWith('octocode-git-command-'));
		await fs.rm(fixtureRoot, { recursive: true, force: true });
		assert.strictEqual(await fs.stat(fixtureRoot).then(() => true, () => false), false);
	});
	async function withFixture(body: (git: Git, owned: string, output: string[]) => Promise<void>): Promise<void> {
		const owned = path.join(fixtureRoot, String(++sequence));
		await fs.mkdir(owned);
		const git = new Git({ gitPath, version: gitVersion, userAgent: 'Owned Git command test', env: fixtureEnv });
		const output: string[] = [];
		const onOutput = (text: string) => output.push(text);
		git.onOutput.addListener('log', onOutput);
		try {
			await body(git, owned, output);
		} finally {
			git.onOutput.removeListener('log', onOutput);
			assert.strictEqual(path.dirname(owned), fixtureRoot);
			assert.ok(path.relative(fixtureRoot, owned) && !path.relative(fixtureRoot, owned).startsWith('..'));
			await fs.rm(owned, { recursive: true, force: true });
			assert.strictEqual(await fs.stat(owned).then(() => true, () => false), false);
		}
	}
	async function withRepository(body: (repo: Repository, git: Git, owned: string, output: string[]) => Promise<void>): Promise<void> {
		await withFixture(async (git, owned, output) => {
			await git.exec(owned, ['init', '-b', 'main']);
			await fs.writeFile(path.join(owned, 'base.txt'), 'Owned initial\n');
			await git.exec(owned, ['add', '--', 'base.txt']);
			await git.exec(owned, ['commit', '-m', 'Owned initial commit']);
			const dotGit = await git.getRepositoryDotGit(owned);
			const repo = git.open(owned, owned, dotGit, logger);
			await body(repo, git, owned, output);
		});
	}
	for (const mode of ['plain-control', 'clone-userinfo', 'stream-userinfo', 'cancel-userinfo']) {
		test(`HTTP URL userinfo logging: ${mode}`, () => withFixture(async (git, owned, output) => {
			const userinfo = 'owned-user-20261003:owned-token-20261003';
			const sockets = new Set<Socket>();
			const requests: { path: string; syntheticAuthorization: boolean }[] = [];
			let requestReceived: (() => void) | undefined;
			const server = http.createServer((req, res) => {
				requests.push({ path: req.url!, syntheticAuthorization: req.headers.authorization === 'Basic ' + Buffer.from(userinfo).toString('base64') });
				requestReceived?.();
				if (mode === 'cancel-userinfo') { return; }
				res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="owned-local-fixture"', 'Connection': 'close' });
				res.end('Owned local authentication rejection');
			});
			server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
			try {
				await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
				const address = server.address();
				assert.ok(address && typeof address !== 'string');
				const url = `http://${mode === 'plain-control' ? '' : userinfo + '@'}127.0.0.1:${address.port}/owned.git`;
				if (mode === 'stream-userinfo') {
					const child = git.stream(owned, ['ls-remote', url]);
					child.stdout!.resume(); child.stderr!.resume();
					const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
					assert.notStrictEqual(code, 0);
				} else if (mode === 'cancel-userinfo') {
					const cancellation = new EventEmitter<void>();
					const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
					const seen = new Promise<void>(resolve => requestReceived = resolve);
					let childClosed: Promise<void> | undefined;
					try {
						const operation = assert.rejects(git.exec(owned, ['clone', url, path.join(owned, 'cloned'), '--progress'], {
							cancellationToken: token,
							onSpawn: child => childClosed = new Promise<void>(resolve => child.once('close', () => resolve()))
						}), CancellationError);
						await seen;
						token.isCancellationRequested = true;
						cancellation.fire();
						await operation;
						assert.ok(childClosed);
						for (const socket of sockets) { socket.destroy(); }
						await childClosed;
					} finally {
						cancellation.dispose();
					}
					assert.ok(output.some(text => text.includes('(cancelled)')));
				} else {
					await assert.rejects(git.clone(url, { parentPath: owned, targetName: 'cloned', progress: { report() { } } }), GitError);
				}
				assert.ok(requests.length > 0);
				if (mode === 'clone-userinfo' || mode === 'stream-userinfo') {
					assert.ok(requests.some(row => row.syntheticAuthorization), 'actual authentication argv remains intact');
				}
				assert.ok(output.some(text => text.startsWith('> git ') && text.includes(`127.0.0.1:${address.port}/owned.git`)));
				assert.ok(output.every(text => !text.includes('owned-user-20261003') && !text.includes('owned-token-20261003')));
				if (mode === 'plain-control') { assert.ok(output.some(text => text.includes(url))); }
			} finally {
				for (const socket of sockets) { socket.destroy(); }
				if (server.listening) { await new Promise<void>(resolve => server.close(() => resolve())); }
			}
		}));
	}
	for (const [value, displayed] of [
		['https://owned-user:owned-token@host.invalid/owned.git', 'https://<redacted>@host.invalid/owned.git'],
		['HTTP://owned-token@host.invalid/owned.git', 'HTTP://<redacted>@host.invalid/owned.git'],
		['https://owned%40user:owned%3Atoken@host.invalid/owned.git', 'https://<redacted>@host.invalid/owned.git'],
		['https://host.invalid/path@name', 'https://host.invalid/path@name'],
		['git@host.invalid:owned.git', 'git@host.invalid:owned.git'],
		['ordinary nonsecret text', 'ordinary nonsecret text']
	]) {
		test(`preserves execution result and safe command display for ${value}`, () => withFixture(async (git, owned, output) => {
			const result = await git.exec(owned, ['-c', `owned.fixture=${value}`, 'config', '--get', 'owned.fixture']);
			assert.strictEqual(result.stdout.trim(), value, 'returned data is unchanged');
			assert.ok(output.some(text => text.startsWith('> git ') && text.includes(`owned.fixture=${displayed}`)));
			if (displayed !== value) { assert.ok(output.every(text => !text.includes(value))); }
		}));
	}
	for (const [from, to] of [['owned.txt', 'renamed.txt'], ['nested/owned name.txt', 'nested/new name.txt'], ['-owned.txt', 'renamed.txt'], ['owned.txt', '-renamed.txt']]) {
		test(`moves tracked relative operand ${from} to ${to}`, () => withRepository(async (repo, git, owned) => {
			await fs.mkdir(path.dirname(path.join(owned, from)), { recursive: true });
			await fs.writeFile(path.join(owned, from), 'Owned rename content\n');
			await git.exec(owned, ['add', '--', from]);
			await git.exec(owned, ['commit', '-m', 'Owned tracked rename path']);
			await repo.move(from, to);
			assert.strictEqual(await fs.stat(path.join(owned, from)).then(() => true, () => false), false);
			assert.strictEqual(await fs.readFile(path.join(owned, to), 'utf8'), 'Owned rename content\n');
			assert.strictEqual((await git.exec(owned, ['status', '--porcelain', '-z'])).stdout, `R  ${to}\0${from}\0`);
		}));
	}
	for (const mode of ['configured-hook-control', 'environment-identity-hook', 'environment-identity-index-lock']) {
		test(`preserves actionable original commit failure for ${mode}`, () => withRepository(async (repo, git, owned) => {
			if (mode === 'configured-hook-control') {
				await git.exec(owned, ['config', 'user.name', 'Owned configured fixture']);
				await git.exec(owned, ['config', 'user.email', 'owned-configured@example.invalid']);
			}
			await fs.writeFile(path.join(owned, 'base.txt'), 'Owned staged change\n');
			await git.exec(owned, ['add', '--', 'base.txt']);
			const lockPath = path.join(owned, '.git', 'index.lock');
			if (mode === 'environment-identity-index-lock') {
				await fs.writeFile(lockPath, 'Owned external lock fixture\n', { flag: 'wx' });
			} else {
				const hooks = path.join(owned, 'owned-hooks');
				await fs.mkdir(hooks);
				await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "OWNED-HOOK-REJECTED\\n" >&2\nexit 1\n', { mode: 0o700 });
				await git.exec(owned, ['config', 'core.hooksPath', hooks]);
			}
			try {
				await assert.rejects(repo.commit('Owned rejected commit', { requireUserConfig: false }), (err: unknown) => {
					assert.ok(err instanceof GitError);
					assert.ok(err.stderr?.includes(mode === 'environment-identity-index-lock' ? 'index.lock' : 'OWNED-HOOK-REJECTED'));
					assert.strictEqual(err.gitArgs?.[0], 'commit');
					assert.notStrictEqual(err.gitErrorCode, 'NoUserNameConfigured');
					assert.notStrictEqual(err.gitErrorCode, 'NoUserEmailConfigured');
					return true;
				});
			} finally {
				if (mode === 'environment-identity-index-lock') { await fs.unlink(lockPath); }
			}
			assert.strictEqual((await git.exec(owned, ['log', '-1', '--format=%s'])).stdout.trim(), 'Owned initial commit');
		}));
	}
	for (const configuredName of [false, true]) {
		test(`retains original identity failure and missing ${configuredName ? 'email' : 'name'} classification`, () => withRepository(async (_repo, git, owned) => {
			if (configuredName) { await git.exec(owned, ['config', 'user.name', 'Owned configured name']); }
			const identityKeys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
			const previousIdentity = identityKeys.map(key => [key, process.env[key]] as const);
			const noIdentityEnv = { ...fixtureEnv };
			for (const key of identityKeys) { delete noIdentityEnv[key]; delete process.env[key]; }
			try {
				const noIdentityGit = new Git({ gitPath, version: gitVersion, userAgent: 'Owned identity test', env: noIdentityEnv });
				const dotGit = await noIdentityGit.getRepositoryDotGit(owned);
				const noIdentityRepo = noIdentityGit.open(owned, owned, dotGit, logger);
				await fs.writeFile(path.join(owned, 'base.txt'), 'Owned staged identity test\n');
				await git.exec(owned, ['add', '--', 'base.txt']);
				await assert.rejects(noIdentityRepo.commit('Owned missing identity commit'), (err: unknown) => {
					assert.ok(err instanceof GitError);
					assert.ok(err.stderr?.includes('Please tell me who you are.'));
					assert.strictEqual(err.gitArgs?.includes('commit'), true);
					assert.strictEqual(err.gitErrorCode, configuredName ? 'NoUserEmailConfigured' : 'NoUserNameConfigured');
					return true;
				});
			} finally {
				for (const [key, value] of previousIdentity) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
			}
		}));
	}
	for (const [mode, filename, collision] of [
		['ordinary-control', 'plain-template.txt', false],
		['internal-space-control', 'template with space.txt', false],
		['leading-space-existing', '  leading-template.txt', false],
		['leading-space-with-decoy', '  collision-template.txt', true]
	] as const) {
		test(`commit template path contract: ${mode}`, () => withRepository(async (repo, git, owned) => {
			const expected = `Owned exact template ${mode}`;
			await fs.writeFile(path.join(owned, filename), expected);
			if (collision) {
				await fs.writeFile(path.join(owned, filename.trim()), 'Wrong decoy template');
			}
			await git.exec(owned, ['config', '--local', 'commit.template', filename]);
			assert.strictEqual((await git.exec(owned, ['config', '--null', '--get', 'commit.template'])).stdout, filename + '\0');
			assert.strictEqual(await repo.getCommitTemplate(), expected);
		}));
	}
	for (const lastEmpty of [false, true]) {
		test(`Git automatic clone and config input contract: occupied auto names ${lastEmpty ? 'last empty' : 'last nonempty'}`, () => withFixture(async (git, owned, output) => {
			const seed = path.join(owned, 'seed');
			const parent = path.join(owned, 'destinations');
			await fs.mkdir(seed);
			await fs.mkdir(parent);
			await git.exec(seed, ['init', '-b', 'main']);
			await git.exec(seed, ['commit', '--allow-empty', '-m', 'Owned clone seed']);
			for (let i = 0; i < 20; i++) {
				const occupied = path.join(parent, i === 0 ? 'seed' : `seed-${i}`);
				await fs.mkdir(occupied);
				if (!lastEmpty || i < 19) { await fs.writeFile(path.join(occupied, 'sentinel'), `Owned occupied ${i}`); }
			}
			const offset = output.length;
			await assert.rejects(git.clone(seed, { parentPath: parent, progress: { report() { } } }), (err: unknown) => {
				assert.ok(err instanceof Error);
				assert.strictEqual(err.constructor, Error, 'bounded exhaustion must be an intentional error');
				assert.ok(err.message.length > 0);
				return true;
			});
			assert.ok(output.slice(offset).every(text => !text.startsWith('> git clone ')));
			for (let i = 0; i < 20; i++) {
				const occupied = path.join(parent, i === 0 ? 'seed' : `seed-${i}`);
				if (!lastEmpty || i < 19) { assert.strictEqual(await fs.readFile(path.join(occupied, 'sentinel'), 'utf8'), `Owned occupied ${i}`); }
				else { assert.deepStrictEqual(await fs.readdir(occupied), []); }
			}
		}));
	}
	test('Git automatic clone and config input contract: explicit empty remains valid', () => withFixture(async (git, owned) => {
		const seed = path.join(owned, 'seed');
		const destination = path.join(owned, 'empty-target');
		await fs.mkdir(seed);
		await fs.mkdir(destination);
		await git.exec(seed, ['init', '-b', 'main']);
		await git.exec(seed, ['commit', '--allow-empty', '-m', 'Owned explicit seed']);
		const expected = (await git.exec(seed, ['rev-parse', 'HEAD'])).stdout.trim();
		assert.strictEqual(await git.clone(seed, { parentPath: owned, targetName: 'empty-target', progress: { report() { } } }), destination);
		assert.strictEqual((await git.exec(destination, ['rev-parse', 'HEAD'])).stdout.trim(), expected);
	}));
	for (const key of ['http.extraHeader', 'http.https://host.invalid/.extraHeader']) {
		test(`Git automatic clone and config input contract: sensitive ${key} lifecycle`, () => withRepository(async (repo, git, owned, output) => {
			const value = 'Authorization: Bearer OWNED_NOT_A_SECRET';
			const offset = output.length;
			await repo.config('add', 'local', key, value);
			assert.strictEqual(await repo.config('get', 'local', key), value);
			assert.strictEqual((await git.exec(owned, ['config', '--local', '--get', key], { log: false })).stdout.trim(), value);
			await repo.config('unset', 'local', key);
			assert.strictEqual(await repo.config('get', 'local', key), '');
			assert.ok(output.slice(offset).every(text => !text.includes(value)));
			const benign = 'owned-visible-diagnostic';
			await repo.config('add', 'local', 'owned.fixture', benign);
			assert.ok(output.slice(offset).some(text => text.includes(benign)));
		}));
	}
	for (const before of [false, true]) {
		test(`Git automatic clone and config input contract: inert core subsection ${before ? 'before' : 'after'}`, () => withRepository(async (_repo, git, owned) => {
			const configPath = path.join(owned, '.git', 'config');
			const original = await fs.readFile(configPath);
			const subsection = Buffer.from('[core "owned-inert-subsection"]\n\tbare = true\n');
			try {
				await fs.writeFile(configPath, Buffer.concat(before ? [subsection, original] : [original, subsection]));
				assert.strictEqual((await git.exec(owned, ['config', '--local', '--bool', '--get', 'core.bare'])).stdout.trim(), 'false');
				assert.strictEqual((await git.exec(owned, ['rev-parse', '--is-bare-repository'])).stdout.trim(), 'false');
				const dotGit = await git.getRepositoryDotGit(owned);
				assert.strictEqual(dotGit.isBare, false);
				const reopened = git.open(owned, owned, dotGit, logger);
				assert.ok((await reopened.getWorktrees()).some(worktree => worktree.main));
			} finally { await fs.writeFile(configPath, original); }
		}));
	}
	for (const eol of ['\n', '\r\n']) {
		for (const mode of ['unquoted', 'quoted', 'multiple']) {
			test(`Git automatic clone and config input contract: remote continuation ${eol.length}/${mode}`, () => withRepository(async (repo, git, owned) => {
				const value = mode === 'quoted' ? '"../owned-\\' + eol + 'remote.git"'
					: mode === 'multiple' ? '../owned-\\' + eol + 'remote-\\' + eol + 'path.git'
						: '../owned-\\' + eol + 'remote.git';
				await fs.appendFile(path.join(owned, '.git', 'config'), '[remote "owned-continuation"]' + eol + '\turl = ' + value + eol);
				const native = (await git.exec(owned, ['config', '--local', '--get', 'remote.owned-continuation.url'])).stdout.trim();
				assert.strictEqual((await repo.getRemotes()).find(remote => remote.name === 'owned-continuation')?.fetchUrl, native);
			}));
		}
		test(`Git automatic clone and config input contract: comment backslash ${eol.length}`, () => withRepository(async (repo, git, owned) => {
			await fs.appendFile(path.join(owned, '.git', 'config'), '[remote "owned-comment"]' + eol
				+ '\turl = ../owned.git # comment \\' + eol + '\tpushurl = ../pushed.git' + eol);
			const nativeFetch = (await git.exec(owned, ['config', '--local', '--get', 'remote.owned-comment.url'])).stdout.trim();
			const nativePush = (await git.exec(owned, ['config', '--local', '--get', 'remote.owned-comment.pushurl'])).stdout.trim();
			const remote = (await repo.getRemotes()).find(remote => remote.name === 'owned-comment');
			assert.strictEqual(remote?.fetchUrl, nativeFetch);
			assert.strictEqual(remote?.pushUrl, nativePush);
		}));
	}

	for (const mode of ['clean', 'conflict-diff2', 'conflict-diff3', 'fatal-missing-input']) {
		test(`Git merge, error display and comment contract: ${mode}`, () => withFixture(async (git, owned) => {
			const basePath = path.join(owned, 'base.txt');
			const input1Path = path.join(owned, 'left.txt');
			const input2Path = path.join(owned, 'right.txt');
			await fs.writeFile(basePath, 'Owned base\n');
			await fs.writeFile(input1Path, mode === 'clean' ? 'Owned base\n' : 'Owned left\n');
			await fs.writeFile(input2Path, 'Owned right\n');
			if (mode === 'fatal-missing-input') { await fs.unlink(input1Path); }
			const diff3 = mode === 'conflict-diff3';
			const nativeArgs = ['merge-file', '-p', input1Path, basePath, input2Path, diff3 ? '--diff3' : '--no-diff3'];
			let nativeOutput: string;
			let nativeError: GitError | undefined;
			try {
				nativeOutput = (await git.exec(owned, nativeArgs)).stdout;
				assert.strictEqual(mode, 'clean');
			} catch (err) {
				assert.ok(err instanceof GitError);
				assert.strictEqual(err.exitCode, mode === 'fatal-missing-input' ? 255 : 1);
				nativeOutput = err.stdout!;
				nativeError = err;
			}
			if (mode === 'fatal-missing-input') {
				assert.strictEqual(nativeOutput, '');
				await assert.rejects(git.mergeFile({ input1Path, input2Path, basePath }), (err: unknown) => {
					assert.ok(err instanceof GitError);
					assert.strictEqual(err.exitCode, 255);
					assert.strictEqual(err.stdout, '');
					assert.strictEqual(err.stderr, nativeError!.stderr);
					assert.deepStrictEqual(err.gitArgs, nativeArgs);
					return true;
				});
			} else {
				if (mode !== 'clean') { assert.ok(nativeOutput.includes('<<<<<<<')); }
				assert.strictEqual(await git.mergeFile({ input1Path, input2Path, basePath, diff3 }), nativeOutput);
			}
			assert.strictEqual(await fs.readFile(input2Path, 'utf8'), 'Owned right\n');
		}));
	}
	for (const mode of ['remote-lock', 'malformed-config-key']) {
		test(`Git merge, error display and comment contract: error userinfo ${mode}`, () => withRepository(async (_repo, git, owned) => {
			const marker = 'OWNED_NOT_A_SECRET';
			const url = `https://owned:${marker}@host.invalid/owned.git`;
			const args = mode === 'remote-lock' ? ['remote', 'add', 'owned', url] : ['config', '--local', '--get', url];
			const lock = path.join(owned, '.git', 'config.lock');
			if (mode === 'remote-lock') { await fs.writeFile(lock, 'Owned lock\n', { flag: 'wx' }); }
			try {
				await assert.rejects(git.exec(owned, args), (err: unknown) => {
					assert.ok(err instanceof GitError);
					assert.strictEqual(err.exitCode, mode === 'remote-lock' ? 128 : 1);
					assert.deepStrictEqual(err.gitArgs, args);
					assert.ok(err.stderr?.includes(marker), 'raw native error remains available for matching');
					assert.ok(!err.toString().includes(marker), 'public diagnostic text omits URL userinfo');
					assert.ok(err.toString().includes('https://<redacted>@host.invalid/owned.git'));
					return true;
				});
			} finally {
				if (mode === 'remote-lock') { await fs.unlink(lock); }
			}
		}));
	}
	test('Git merge, error display and comment contract: ordinary error diagnostic preserved', () => {
		const error = new GitError({ message: 'Owned ordinary error', stdout: 'Owned stdout', stderr: 'Owned stderr', exitCode: 7 });
		assert.ok(error.toString().includes('Owned ordinary error'));
		assert.ok(error.toString().includes('Owned stdout'));
		assert.ok(error.toString().includes('Owned stderr'));
		assert.strictEqual(error.exitCode, 7);
	});
	const commentCases = [
		{ name: 'global', global: '[core]\n\tcommentChar = ";"\n', local: '', prefix: ';' },
		{ name: 'included', global: '', local: '', prefix: '!' },
		{ name: 'string-last', global: '', local: '[core]\n\tcommentChar = ";"\n\tcommentString = //\n', prefix: '//', modern: true },
		{ name: 'char-last', global: '', local: '[core]\n\tcommentString = //\n\tcommentChar = ";"\n', prefix: ';', modern: true },
		{ name: 'repeated-char', global: '', local: '[core]\n\tcommentChar = ";"\n\tcommentChar = !\n', prefix: '!' },
		{ name: 'local-over-global', global: '[core]\n\tcommentChar = ";"\n', local: '[core]\n\tcommentChar = !\n', prefix: '!' },
		{ name: 'multibyte', global: '', local: '[core]\n\tcommentChar = ※\n', prefix: '※', modern: true },
		{ name: 'auto', global: '', local: '[core]\n\tcommentChar = auto\n', prefix: null },
		{ name: 'default-indented', global: '', local: '[core]\n\tcommentChar = "#"\n', prefix: '#', indented: true },
		{ name: 'custom-indented', global: '', local: '[core]\n\tcommentChar = ";"\n', prefix: ';', indented: true },
		{ name: 'literal-metacharacters', global: '', local: '[core]\n\tcommentString = "[x]"\n', prefix: '[x]', modern: true },
		{ name: 'literal-leading-spaces', global: '', local: '[core]\n\tcommentString = "  ;"\n', prefix: '  ;', modern: true }
	];
	for (const entry of commentCases) {
		test(`Git merge, error display and comment contract: effective prefix ${entry.name}`, async function () {
			if (entry.modern && gitVersion && new Git({ gitPath, version: gitVersion, userAgent: 'Owned version check' }).compareGitVersionTo('2.45') === -1) {
				this.skip();
			}
			await withRepository(async (repo, git, owned) => {
				const globalPath = fixtureEnv.GIT_CONFIG_GLOBAL;
				const beforeGlobal = await fs.readFile(globalPath);
				try {
					await fs.writeFile(globalPath, entry.global);
					await fs.appendFile(path.join(owned, '.git', 'config'), entry.local);
					if (entry.name === 'included') {
						const includePath = path.join(owned, 'owned-include.config');
						await fs.writeFile(includePath, '[core]\n\tcommentChar = !\n');
						await fs.appendFile(globalPath, '[include]\n\tpath = ' + JSON.stringify(includePath.replace(/\\/g, '/')) + '\n');
					}
					const body = entry.indented ? '    # Owned meaningful indentation' : '#1234 Owned meaningful body';
					const message = entry.name === 'auto' ? '#1234 Owned issue\n; Owned text begins semicolon\nBody\n'
						: `Owned subject\n\n${body}\n` + (entry.prefix === null ? '' : `${entry.prefix} Owned generated comment\n`);
					const expected = entry.name === 'auto' ? message.trim() : `Owned subject\n\n${body}`;
					const template = path.join(owned, 'owned-template.txt');
					await fs.writeFile(template, message);
					await git.exec(owned, ['config', '--local', 'commit.template', template]);
					await git.exec(owned, ['commit', '--allow-empty', '--cleanup=strip', '-F', template]);
					assert.strictEqual((await git.exec(owned, ['log', '-1', '--format=%B'])).stdout.trim(), expected, 'native commit control');
					await fs.writeFile(path.join(owned, '.git', 'MERGE_MSG'), message);
					await fs.writeFile(path.join(owned, '.git', 'SQUASH_MSG'), message);
					assert.strictEqual(await repo.getCommitTemplate(), expected, 'configured template getter');
					assert.strictEqual(await repo.getMergeMessage(), expected, 'merge message getter');
					assert.strictEqual(await repo.getSquashMessage(), expected, 'squash message getter');
				} finally { await fs.writeFile(globalPath, beforeGlobal); }
			});
		});
	}
	for (const eol of ['\n', '\r\n']) {
		test(`Git merge, error display and comment contract: retain literal lines and EOL ${eol.length}`, () => withRepository(async repo => {
			const message = ['Owned subject', '', '    # Literal meaningful line', '# Generated comment', 'Owned last'].join(eol);
			const expected = ['Owned subject', '', '    # Literal meaningful line', 'Owned last'].join(eol);
			assert.strictEqual(repo.stripCommitMessageComments(message), expected);
		}));
	}
	test('Git merge, error display and comment contract: unknown config preserves existing messages', () => withRepository(async (repo, git, owned) => {
		const message = 'Owned subject\n\n#1234 Owned meaningful body\n';
		await fs.writeFile(path.join(owned, '.git', 'MERGE_MSG'), message);
		await fs.writeFile(path.join(owned, '.git', 'SQUASH_MSG'), message);
		const config = path.join(owned, '.git', 'config');
		const beforeConfig = await fs.readFile(config);
		try {
			await fs.appendFile(config, '[broken\n');
			await assert.rejects(git.exec(owned, ['config', '--null', '--get-regexp', '^core\\.comment(char|string)$'], { log: false }), (err: unknown) => {
				assert.ok(err instanceof GitError);
				assert.ok(err.stderr?.length);
				return true;
			});
			assert.strictEqual(await repo.getMergeMessage(), message.trim());
			assert.strictEqual(await repo.getSquashMessage(), message.trim());
		} finally { await fs.writeFile(config, beforeConfig); }
	}));
	test('commit template path contract: unset template stays empty', () => withRepository(async (repo, git, owned) => {
		await assert.rejects(git.exec(owned, ['config', '--null', '--get', 'commit.template']), (err: unknown) => {
			assert.ok(err instanceof GitError);
			return err.exitCode === 1;
		});
		assert.strictEqual(await repo.getCommitTemplate(), '');
	}));
	test('commit template path contract: missing template stays empty', () => withRepository(async (repo, git, owned) => {
		const filename = '  missing-template.txt';
		await git.exec(owned, ['config', '--local', 'commit.template', filename]);
		assert.strictEqual((await git.exec(owned, ['config', '--null', '--get', 'commit.template'])).stdout, filename + '\0');
		assert.strictEqual(await fs.stat(path.join(owned, filename)).then(() => true, () => false), false);
		assert.strictEqual(await repo.getCommitTemplate(), '');
	}));
});
