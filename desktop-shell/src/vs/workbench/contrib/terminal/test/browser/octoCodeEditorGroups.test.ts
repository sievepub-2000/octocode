/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { getOctoCodeTerminalGroup } from '../../../octocode/browser/octoCodeEditorGroups.js';

suite('OctoCode fixed terminal group', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('creates missing panes without falling back to the panel', () => {
		let groups = [{ id: 1 }] as IEditorGroup[];
		const service = {
			get count() { return groups.length; }, getGroups: () => groups,
			applyLayout: (layout: unknown) => {
				deepStrictEqual(layout, { orientation: 0, groups: [{ size: 0.58 }, { size: 0.42, groups: [{ size: 0.75 }, { size: 0.25 }] }] });
				groups = [{ id: 1 }, { id: 2 }, { id: 3 }] as IEditorGroup[];
			},
		} as unknown as IEditorGroupsService;
		strictEqual(getOctoCodeTerminalGroup(service).id, 3);
	});
	test('keeps an existing layout and its terminal group', () => {
		const target = { id: 3 } as IEditorGroup;
		const service = {
			count: 3, getGroups: () => [{ id: 1 }, { id: 2 }, target],
			applyLayout: () => { throw new Error('Existing layout must remain intact'); },
		} as unknown as IEditorGroupsService;
		strictEqual(getOctoCodeTerminalGroup(service), target);
	});
	test('uses the lower-right group when additional panes exist', () => {
		const target = { id: 4 } as IEditorGroup;
		const service = {
			count: 4, getGroups: () => [{ id: 1 }, { id: 2 }, { id: 3 }, target],
			applyLayout: () => { throw new Error('Existing editors must remain intact'); },
		} as unknown as IEditorGroupsService;
		strictEqual(getOctoCodeTerminalGroup(service), target);
	});
});
