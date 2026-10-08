/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindow } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRunScriptCustomTaskWidgetResult, IRunScriptCustomTaskWidgetState, RunScriptCustomTaskWidget } from '../../browser/runScriptCustomTaskWidget.js';

suite('RunScriptCustomTaskWidget', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let container: HTMLElement;

	setup(() => {
		container = document.createElement('div');
		disposables.add(toDisposable(() => container.remove()));
		document.body.appendChild(container);
	});

	function createWidget(state: IRunScriptCustomTaskWidgetState) {
		const widget = disposables.add(new RunScriptCustomTaskWidget(state));
		container.appendChild(widget.domNode);
		const storageOptions = Array.from(widget.domNode.querySelectorAll<HTMLElement>('[role="radio"] > [role="button"]'));
		const submit = widget.domNode.querySelector<HTMLElement>('.run-script-action-buttons > [role="button"]:last-child')!;
		const submittedTargets: IRunScriptCustomTaskWidgetResult['target'][] = [];
		disposables.add(widget.onDidSubmit(result => submittedTargets.push(result.target)));

		return {
			workspace: storageOptions[0],
			user: storageOptions[1],
			submit,
			submittedTargets,
			readStorage: () => ({
				disabled: storageOptions.map(button => button.getAttribute('aria-disabled')),
				active: storageOptions.map(button => button.classList.contains('active')),
			}),
		};
	}

	test('does not select or submit an unavailable workspace when no target was specified', () => {
		const widget = createWidget({
			command: 'echo regression',
			targetDisabledReason: 'Workspace storage is unavailable for this session',
		});

		widget.workspace.click();
		widget.submit.click();

		assert.deepStrictEqual({
			storage: widget.readStorage(),
			submittedTargets: widget.submittedTargets,
		}, {
			storage: { disabled: ['true', 'false'], active: [false, true] },
			submittedTargets: ['user'],
		});
	});

	for (const { target, expectedActive } of [
		{ target: 'workspace', expectedActive: [true, false] },
		{ target: 'user', expectedActive: [false, true] },
	] as const) {
		test(`keeps both storage choices disabled for an existing ${target} task`, () => {
			const widget = createWidget({
				command: 'echo regression',
				target,
				targetDisabledReason: 'This existing task cannot be moved between workspace and user storage.',
				mode: 'add-existing',
			});

			widget.workspace.click();
			const afterWorkspaceClick = widget.readStorage();
			widget.user.click();
			const afterUserClick = widget.readStorage();
			widget.submit.click();

			assert.deepStrictEqual({
				afterWorkspaceClick,
				afterUserClick,
				submittedTargets: widget.submittedTargets,
			}, {
				afterWorkspaceClick: { disabled: ['true', 'true'], active: expectedActive },
				afterUserClick: { disabled: ['true', 'true'], active: expectedActive },
				submittedTargets: [target],
			});
		});
	}

	test('submits the selected target when both storage choices are available', () => {
		const widget = createWidget({ command: 'echo regression' });

		widget.user.click();
		widget.submit.click();
		widget.workspace.click();
		widget.submit.click();

		assert.deepStrictEqual({
			storage: widget.readStorage(),
			submittedTargets: widget.submittedTargets,
		}, {
			storage: { disabled: ['false', 'false'], active: [true, false] },
			submittedTargets: ['user', 'workspace'],
		});
	});

	test('disabled storage choices retain the workbench focus outline', async () => {
		for (const relative of ['../../../../../workbench/browser/media/style.css', '../../browser/media/runScriptAction.css']) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = new URL(relative, import.meta.url).href.replace('/out/', '/src/');
			disposables.add(toDisposable(() => link.remove()));
			await new Promise<void>((resolve, reject) => {
				link.onload = () => resolve();
				link.onerror = () => reject(new Error(`Cannot load workbench stylesheet: ${relative}`));
				document.head.appendChild(link);
			});
		}
		container.classList.add('monaco-workbench');
		container.style.setProperty('--vscode-focusBorder', '#007fd4');
		const widget = createWidget({ command: 'echo regression', target: 'user', targetDisabledReason: 'Storage target is locked' });
		const outlines = [widget.workspace, widget.user].map(button => {
			button.focus();
			const style = getWindow(button).getComputedStyle(button);
			return {
				focused: document.activeElement === button,
				disabled: button.getAttribute('aria-disabled'),
				outlineStyle: style.outlineStyle,
				outlineWidth: style.outlineWidth,
				outlineColor: style.outlineColor,
			};
		});

		const expected = { focused: true, disabled: 'true', outlineStyle: 'solid', outlineWidth: '1px', outlineColor: 'rgb(0, 127, 212)' };
		assert.deepStrictEqual(outlines, [expected, expected]);
	});
});
