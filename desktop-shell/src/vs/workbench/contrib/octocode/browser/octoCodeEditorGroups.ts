/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

/** Restore missing panes before opening a terminal or diagnostic channel. */
export function getOctoCodeTerminalGroup(service: IEditorGroupsService): IEditorGroup {
	if (service.count < 3) {
		service.applyLayout({ orientation: 0, groups: [{ size: 0.58 }, { size: 0.42, groups: [{ size: 0.75 }, { size: 0.25 }] }] });
	}
	const target = service.getGroups(GroupsOrder.GRID_APPEARANCE).at(-1);
	if (!target) { throw new Error('OctoCode lower-right terminal group is unavailable'); }
	return target;
}
