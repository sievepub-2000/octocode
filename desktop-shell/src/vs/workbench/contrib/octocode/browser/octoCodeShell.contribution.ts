/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableWindowInterval, getActiveWindow } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IEditorGroupsService, GroupsOrder } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, OCTOCODE_SHELL_ENABLED, Parts } from '../../../services/layout/browser/layoutService.js';
import { TerminalEditorInput } from '../../terminal/browser/terminalEditorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Schemas } from '../../../../base/common/network.js';

import './media/octoCodeShell.css';

CommandsRegistry.registerCommand('workbench.action.octocode.placeRuntimeTerminal', (accessor, name: unknown) => {
	if (typeof name !== 'string' || !name) { return; }
	const groups = accessor.get(IEditorGroupsService).getGroups(GroupsOrder.GRID_APPEARANCE);
	const target = groups.at(-1);
	if (groups.length < 3 || !target) { return; }
	for (const group of groups) {
		const editor = group.editors.find(editor => editor instanceof TerminalEditorInput && editor.getName() === name);
		if (editor) {
			if (group !== target) { group.moveEditor(editor, target, { preserveFocus: true }); }
			return;
		}
	}
});

for (const [command, title, icon] of [
	['restoreWorkbenchLayout', localize('octocode.restoreLayout', 'Restore layout: chat left, preview upper right, terminal lower right'), Codicon.layout],
	['openArtifactPanel', localize('octocode.showPreview', 'Open upper-right preview'), Codicon.openPreview],
	['openRuntimeTerminal', localize('octocode.showTerminal', 'Open lower-right terminal'), Codicon.terminal],
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: `workbench.action.octocode.${command}`, title, icon,
				menu: { id: MenuId.LayoutControlMenu, group: 'navigation',
					when: ContextKeyExpr.equals(`config.${OCTOCODE_SHELL_ENABLED}`, true) } });
		}
		run(accessor: Parameters<Action2['run']>[0]): Promise<unknown> {
			return accessor.get(ICommandService).executeCommand(`octocode.${command}`);
		}
	});
}

/**
 * Focus an editor group by its position in the grid, from a webview.
 *
 * The management rail replaced the editor groups' tab strips, and it lives in a
 * webview. `workbench.action.focusNthEditorGroup` is not enough there: a focused
 * webview holds the browser's focus, so the group is marked active — the window
 * title even changes — while every keystroke still goes to the webview. Measured
 * on a running build: after selecting the terminal from the rail,
 * `document.activeElement` was still the webview's iframe and typing landed in
 * the chat box.
 *
 * Releasing that hold first is what makes the focus land. Verified in the same
 * window: blurring the iframe moved the active element to BODY, after which
 * focusing the terminal put it on the xterm textarea and it accepted input.
 */
export const OCTOCODE_FOCUS_GROUP_COMMAND = 'workbench.action.octocode.focusEditorGroupByPosition';

CommandsRegistry.registerCommand(OCTOCODE_FOCUS_GROUP_COMMAND, (accessor, position?: unknown) => {
	const index = typeof position === 'number' ? position : Number(position);
	if (!Number.isInteger(index) || index < 0) {
		return;
	}

	// Grid order, not creation order: the rail names panes by where they are on
	// screen, and a group created later can sit anywhere in the grid.
	const groups = accessor.get(IEditorGroupsService).getGroups(GroupsOrder.GRID_APPEARANCE);
	const group = groups[index];
	if (!group) {
		return;
	}

	const takeFocus = () => {
		const active = getActiveWindow().document.activeElement;
		if (active instanceof HTMLIFrameElement) {
			active.blur();
		}
		group.focus();
	};

	takeFocus();

	/*
	 * Take it again once the webview has finished reclaiming it.
	 *
	 * `WebviewElement` re-focuses itself on a delay after it sees a focus event —
	 * the click on the rail button — and that landed *after* this command. Traced
	 * on a running build at 20ms resolution: the terminal's textarea held focus at
	 * +20ms and the webview iframe had it back at +40ms.
	 *
	 * The re-take is conditional, so it can only undo that specific theft: if
	 * anything other than a webview holds focus by now the user has moved on and
	 * this does nothing.
	 */
	// One shot, expressed by returning `true` rather than by the `iterations`
	// argument: that argument short-circuits the handler away on the very tick it
	// would have run.
	disposableWindowInterval(getActiveWindow(), () => {
		const active = getActiveWindow().document.activeElement;
		if (active instanceof HTMLIFrameElement) {
			takeFocus();
		}
		return true;
	}, 120);
});

/**
 * Keeps the window in sync when the shell setting is toggled at runtime.
 *
 * The initial state is NOT decided here. A workbench contribution cannot run
 * before `LifecyclePhase.Restored`, which is after the first paint — deciding it
 * here would show the host chrome and then remove it, the very flash this
 * feature exists to eliminate. `layout.ts` reads the same setting while building
 * the layout state; this class only handles the user changing their mind later.
 */
export class OctoCodeShellContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.octoCodeShell';

	/** OctoCode hosts its terminals and logs in the lower-right editor group. */
	private static readonly CHROME_PARTS: readonly Parts[] = [
		Parts.ACTIVITYBAR_PART,
		Parts.SIDEBAR_PART,
		Parts.AUXILIARYBAR_PART,
		Parts.STATUSBAR_PART,
		Parts.PANEL_PART,
	];

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
	) {
		super();

		// The import-time default below assumes the shell is on, because nothing
		// can read configuration that early. Correct it once for a user who has
		// turned it off; `layout.ts` does the same for the chrome parts.
		setEditorTabsDefault(this.configurationService.getValue<boolean>(OCTOCODE_SHELL_ENABLED) !== false);
		const routeTerminals = () => {
			if (this.configurationService.getValue<boolean>(OCTOCODE_SHELL_ENABLED) === false) { return; }
			const groups = editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
			const target = groups.at(-1);
			if (groups.length < 3 || !target) { return; }
			for (const group of groups) {
				for (const editor of [...group.editors]) {
					if (editor instanceof TerminalEditorInput) {
						if (group !== target) { group.moveEditor(editor, target, { preserveFocus: true }); }
					} else if (editor.resource?.scheme === Schemas.vscodeTerminal) {
						// A migrated text-editor reference cannot reconnect a terminal process.
						// Close only that dead virtual resource; file editors and backups stay intact.
						void group.closeEditor(editor);
					}
				}
			}
		};
		this._register(editorService.onDidVisibleEditorsChange(routeTerminals));
		this._register(editorGroupsService.onDidAddGroup(routeTerminals));
		routeTerminals();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OCTOCODE_SHELL_ENABLED)) {
				const enabled = this.configurationService.getValue<boolean>(OCTOCODE_SHELL_ENABLED) !== false;
				for (const part of OctoCodeShellContribution.CHROME_PARTS) {
					this.layoutService.setPartHidden(enabled, part);
				}
				setEditorTabsDefault(enabled);
			}
		}));
	}
}

/** Native per-pane headers provide keyboard-accessible close actions. */
const EDITOR_PANE_HEADERS: IConfigurationDefaults = {
	overrides: {
		'workbench.editor.showTabs': 'single',
		'workbench.editor.editorActionsLocation': 'default',
	},
};

function setEditorTabsDefault(shellEnabled: boolean): void {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	if (shellEnabled) {
		registry.registerDefaultConfigurations([EDITOR_PANE_HEADERS]);
	} else {
		// Turning the shell off gives the host's own chrome back, tab strips included.
		registry.deregisterDefaultConfigurations([EDITOR_PANE_HEADERS]);
	}
}

/*
 * Applied at import time, not from the contribution above.
 *
 * A workbench contribution cannot run before `LifecyclePhase.Restored`, which is
 * after the first paint — registering the default there would show the tab
 * strips and then remove them, the same flash the shell exists to eliminate.
 * The setting itself is read per-window, so a user who has turned the shell off
 * gets the strips back through `setEditorTabsDefault`.
 */
setEditorTabsDefault(true);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(OctoCodeShellContribution, LifecyclePhase.Restored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'octocode',
	order: 1,
	title: localize('octocode.configurationTitle', "OctoCode"),
	type: 'object',
	properties: {
		[OCTOCODE_SHELL_ENABLED]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('octocode.shell.ownWindowChrome', "Let OctoCode draw the window itself. Turn this off to fall back to the standard editor chrome (activity bar, side bars, status bar and editor tabs)."),
		},
	},
});
