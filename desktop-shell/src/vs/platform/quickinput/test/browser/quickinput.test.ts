/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { unthemedInboxStyles } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { unthemedButtonStyles } from '../../../../base/browser/ui/button/button.js';
import { unthemedListStyles } from '../../../../base/browser/ui/list/listWidget.js';
import { unthemedToggleStyles } from '../../../../base/browser/ui/toggle/toggle.js';
import { Event } from '../../../../base/common/event.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../storage/common/storage.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { unthemedCountStyles } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { unthemedKeybindingLabelOptions } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { unthemedProgressBarOptions } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { QuickInputController } from '../../browser/quickInputController.js';
import { QuickInputBox } from '../../browser/quickInputBox.js';
import { TestThemeService } from '../../../theme/test/common/testThemeService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { QuickPick } from '../../browser/quickInput.js';
import { IQuickInputButton, IQuickPickItem, ItemActivation, isKeyModified, NO_KEY_MODS, QuickInputButtonLocation } from '../../common/quickInput.js';
import { TestInstantiationService } from '../../../instantiation/test/common/instantiationServiceMock.js';
import { IThemeService } from '../../../theme/common/themeService.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { ILayoutService } from '../../../layout/browser/layoutService.js';
import { IContextViewService } from '../../../contextview/browser/contextView.js';
import { IListService, ListService } from '../../../list/browser/listService.js';
import { IContextKeyService } from '../../../contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { NoMatchingKb } from '../../../keybinding/common/keybindingResolver.js';
import { IKeybindingService } from '../../../keybinding/common/keybinding.js';
import { ContextViewService } from '../../../contextview/browser/contextViewService.js';
import { IAccessibilityService } from '../../../accessibility/common/accessibility.js';
import { TestAccessibilityService } from '../../../accessibility/test/common/testAccessibilityService.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { KeyCodeChord } from '../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { USLayoutResolvedKeybinding } from '../../../keybinding/common/usLayoutResolvedKeybinding.js';

// Sets up an `onShow` listener to allow us to wait until the quick pick is shown (useful when triggering an `accept()` right after launching a quick pick)
// kick this off before you launch the picker and then await the promise returned after you launch the picker.
async function setupWaitTilShownListener(controller: QuickInputController): Promise<void> {
	const result = await raceTimeout(new Promise<boolean>(resolve => {
		const event = controller.onShow(_ => {
			event.dispose();
			resolve(true);
		});
	}), 2000);

	if (!result) {
		throw new Error('Cancelled');
	}
}

suite('QuickInput', () => { // https://github.com/microsoft/vscode/issues/147543
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let controller: QuickInputController;
	let fixture: HTMLElement;
	let openedLinks: string[];
	let storageService: InMemoryStorageService;

	setup(() => {
		openedLinks = [];
		fixture = document.createElement('div');
		mainWindow.document.body.appendChild(fixture);
		store.add(toDisposable(() => fixture.remove()));

		const instantiationService = new TestInstantiationService();
		storageService = store.add(new InMemoryStorageService());
		instantiationService.stub(IStorageService, storageService);

		// Stub the services the quick input controller needs to function
		instantiationService.stub(IThemeService, new TestThemeService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IAccessibilityService, new TestAccessibilityService());
		instantiationService.stub(IListService, store.add(new ListService()));
		instantiationService.stub(ILayoutService, {
			_serviceBrand: undefined,
			activeContainer: fixture,
			mainContainer: fixture,
			get activeContainerDimension() { return { width: fixture.clientWidth, height: fixture.clientHeight }; },
			activeContainerOffset: { top: 0, quickPickTop: 0 },
			onDidLayoutContainer: Event.None,
			getContainer: () => fixture,
		});
		instantiationService.stub(IContextViewService, store.add(instantiationService.createInstance(ContextViewService)));
		instantiationService.stub(IContextKeyService, store.add(instantiationService.createInstance(ContextKeyService)));
		instantiationService.stub(IKeybindingService, {
			mightProducePrintableCharacter() { return false; },
			softDispatch() { return NoMatchingKb; },
		});

		controller = store.add(instantiationService.createInstance(
			QuickInputController,
			{
				container: fixture,
				idPrefix: 'testQuickInput',
				ignoreFocusOut() { return true; },
				returnFocus() { },
				backKeybindingLabel() { return undefined; },
				setContextKey() { return undefined; },
				linkOpenerDelegate(content) { openedLinks.push(content); },
				hoverDelegate: {
					showHover(options, focus) {
						return undefined;
					},
					delay: 200
				},
				styles: {
					button: unthemedButtonStyles,
					countBadge: unthemedCountStyles,
					inputBox: unthemedInboxStyles,
					toggle: unthemedToggleStyles,
					keybindingLabel: unthemedKeybindingLabelOptions,
					list: unthemedListStyles,
					progressBar: unthemedProgressBarOptions,
					widget: {
						quickInputBackground: undefined,
						quickInputForeground: undefined,
						quickInputTitleBackground: undefined,
						widgetBorder: undefined,
						widgetShadow: undefined,
					},
					pickerGroup: {
						pickerGroupBorder: undefined,
						pickerGroupForeground: undefined,
					}
				}
			}
		));

		// initial layout
		controller.layout({ height: 20, width: 40 }, 0);
	});

	teardown(() => {
		sinon.restore();
	});

	test('activeItems - listener mutations do not change the focused or accepted item', () => {
		const picker = store.add(controller.createQuickPick());
		const item = { label: 'focused' };
		const other = { label: 'not in the picker' };
		picker.items = [item];
		store.add(picker.onDidChangeActive(items => items.splice(0, items.length, other)));
		let accepted: readonly IQuickPickItem[] = [];
		store.add(picker.onDidAccept(() => accepted = picker.selectedItems.slice()));
		picker.show();
		controller.accept();
		assert.deepStrictEqual({ active: picker.activeItems, accepted }, { active: [item], accepted: [item] });
	});

	for (const method of ['controller', 'picker', 'selection', 'quick navigation'] as const) {
		test(`selectedItems - listener mutations do not change ${method} acceptance`, () => {
			const picker = store.add(controller.createQuickPick());
			const item = { label: 'selected' };
			picker.items = [item];
			picker.show();
			store.add(picker.onDidChangeSelection(items => items.length = 0));
			let accepted: readonly IQuickPickItem[] | undefined;
			store.add(picker.onDidAccept(() => accepted = picker.selectedItems.slice()));
			switch (method) {
				case 'controller': controller.accept(); break;
				case 'picker': picker.accept(); break;
				case 'selection': picker.selectedItems = [item]; break;
				case 'quick navigation':
					picker.quickNavigate = { keybindings: [new USLayoutResolvedKeybinding([new KeyCodeChord(false, false, true, false, KeyCode.KeyP)], OperatingSystem.Windows)] };
					fixture.querySelector('.quick-input-widget')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', keyCode: 18, bubbles: true }));
					break;
			}
			assert.deepStrictEqual({ selected: picker.selectedItems, accepted }, { selected: [item], accepted: [item] });
		});
	}

	test('selectedItems - listener mutations do not change checked items', () => {
		const picker = store.add(controller.createQuickPick());
		const item = { label: 'checked' };
		picker.items = [item];
		picker.canSelectMany = true;
		picker.show();
		store.add(picker.onDidChangeSelection(items => items.length = 0));
		picker.selectedItems = [item];
		assert.deepStrictEqual(picker.selectedItems, [item]);
	});

	test('selectedItems - listener mutations do not turn empty multi-selection into a selection', () => {
		const picker = store.add(controller.createQuickPick());
		const item = { label: 'unchecked' };
		picker.items = [item];
		picker.canSelectMany = true;
		picker.show();
		store.add(picker.onDidChangeSelection(items => items.push(item)));
		let accepted: readonly IQuickPickItem[] | undefined;
		store.add(picker.onDidAccept(() => accepted = picker.selectedItems.slice()));
		controller.accept();
		assert.deepStrictEqual({ selected: picker.selectedItems, accepted }, { selected: [], accepted: [] });
	});

	for (const method of ['controller', 'input'] as const) {
		test(`show - reentrant ${method} hide leaves the input reusable`, () => {
			const input = store.add(controller.createInputBox());
			let hides = 0;
			store.add(input.onDidHide(() => hides++));
			const listener = controller.onShow(() => method === 'controller' ? controller.hide() : input.hide());
			try {
				input.show();
				assert.deepStrictEqual({ visible: controller.isVisible(), hides }, { visible: false, hides: 1 });
			} finally {
				listener.dispose();
			}
			input.show();
			assert.strictEqual(controller.isVisible(), true);
		});
	}

	test('show - reentrant replacement keeps the new input UI and subscriptions', () => {
		const first = store.add(controller.createQuickPick());
		first.title = 'old picker';
		first.value = 'old value';
		const second = store.add(controller.createInputBox());
		second.title = 'new input';
		second.value = 'new value';
		second.prompt = '[literal](command:owned.prompt)';
		second.promptIsPlainText = true;
		let accepted = 0;
		store.add(second.onDidAccept(() => accepted++));
		const listener = controller.onShow(() => {
			listener.dispose();
			second.show();
		});
		first.show();
		first.hide();
		controller.accept();
		assert.deepStrictEqual({
			visible: controller.isVisible(),
			title: fixture.querySelector('.quick-input-title')!.textContent,
			value: fixture.querySelector('input')!.value,
			literalPrompt: fixture.querySelector('.quick-input-message')!.textContent,
			links: fixture.querySelectorAll('.quick-input-message a').length,
			accepted,
		}, { visible: true, title: 'new input', value: 'new value', literalPrompt: '[literal](command:owned.prompt) (Press \'Enter\' to confirm or \'Escape\' to cancel)', links: 0, accepted: 1 });
	});

	test('show - reentrant old input didHide replacement is not overwritten', () => {
		const old = store.add(controller.createInputBox());
		old.show();
		const superseded = store.add(controller.createInputBox());
		superseded.prompt = 'superseded';
		const current = store.add(controller.createInputBox());
		current.prompt = 'current';
		current.value = 'current value';
		store.add(old.onDidHide(() => current.show()));
		superseded.show();
		superseded.hide();
		assert.deepStrictEqual({ visible: controller.isVisible(), value: fixture.querySelector('input')!.value, message: fixture.querySelector('.quick-input-message')!.textContent },
			{ visible: true, value: 'current value', message: 'current (Press \'Enter\' to confirm or \'Escape\' to cancel)' });
	});

	for (const elapsed of [100, 800]) {
		test(`busy progress - hide after ${elapsed}ms cancels and re-arms progress on re-show`, () => {
			const clock = sinon.useFakeTimers();
			const input = store.add(controller.createInputBox());
			input.busy = true;
			input.show();
			clock.tick(elapsed);
			input.hide();
			clock.tick(1000);
			input.show();
			const progress = fixture.querySelector('.quick-input-progress')!;
			clock.tick(799);
			assert.strictEqual(progress.getAttribute('aria-hidden'), 'true');
			clock.tick(1);
			assert.strictEqual(progress.getAttribute('aria-hidden'), null);
			input.busy = false;
			assert.strictEqual(progress.getAttribute('aria-hidden'), 'true');
		});
	}

	test('busy progress - disposing a pending input cancels its timer', () => {
		const clock = sinon.useFakeTimers();
		const input = store.add(controller.createInputBox());
		input.show();
		clock.runAll();
		input.busy = true;
		assert.strictEqual(clock.countTimers(), 1);
		input.dispose();
		clock.tick(0);
		assert.strictEqual(clock.countTimers(), 0);
	});

	test('message replacement - disposes old links without removing value or accept subscriptions', () => {
		const click = (anchor: HTMLAnchorElement) => {
			const event = new mainWindow.MouseEvent('click', { bubbles: true, cancelable: true });
			event.preventDefault(); // Detached links have no listener to prevent default navigation.
			anchor.dispatchEvent(event);
		};
		const input = store.add(controller.createInputBox());
		input.prompt = '[prompt](command:owned.prompt)';
		input.show();
		const message = fixture.querySelector('.quick-input-message')!;
		const promptLink = message.querySelector<HTMLAnchorElement>('a')!;
		input.validationMessage = '[first](command:owned.first)';
		const first = message.querySelector<HTMLAnchorElement>('a')!;
		input.validationMessage = '[second](command:owned.second)';
		const second = message.querySelector<HTMLAnchorElement>('a')!;
		click(promptLink);
		click(first);
		assert.deepStrictEqual(openedLinks, []);
		click(second);
		input.validationMessage = undefined;
		input.promptIsPlainText = true;
		click(second);
		let changed: string | undefined;
		let accepted = 0;
		store.add(input.onDidChangeValue(value => changed = value));
		store.add(input.onDidAccept(() => accepted++));
		const element = fixture.querySelector('input')!;
		element.value = 'edited';
		element.dispatchEvent(new mainWindow.Event('input', { bubbles: true }));
		controller.accept();
		assert.deepStrictEqual({ openedLinks, changed, accepted, links: message.querySelectorAll('a').length },
			{ openedLinks: ['command:owned.second'], changed: 'edited', accepted: 1, links: 0 });
	});

	for (const rejected of ['picks', 'activeItem'] as const) {
		test(`pick - ${rejected} rejection preserves the original error and hides the input`, async () => {
			const error = new Error(`${rejected} failed`);
			const promise = rejected === 'picks'
				? controller.pick(Promise.reject(error))
				: controller.pick([{ label: 'item' }], { activeItem: Promise.reject(error) });
			try {
				const result = await raceTimeout(promise.then(() => undefined, reason => reason), 1000);
				assert.strictEqual(result, error);
				assert.strictEqual(controller.isVisible(), false);
				await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
			} finally {
				controller.hide();
			}
		});
	}

	test('prompt mode defaults to linked text and preserves link dispatch', () => {
		const input = store.add(controller.createInputBox());
		input.prompt = '[owned action](command:owned.prompt)';
		input.show();
		const link = fixture.querySelector<HTMLAnchorElement>('.quick-input-message a')!;
		assert.ok(link);
		link.click();
		assert.deepStrictEqual(openedLinks, ['command:owned.prompt']);
		assert.strictEqual(input.promptIsPlainText, false);
	});

	test('prompt mode renders plain text without interpreting links, icons or markup', () => {
		const input = store.add(controller.createInputBox());
		const prompt = '[command](command:owned.prompt) [file](file:///owned) [web](https://example.invalid) $(warning) <b>原文</b> \\ [字](command:owned.unicode)';
		input.prompt = prompt;
		input.promptIsPlainText = true;
		input.show();
		const message = fixture.querySelector<HTMLElement>('.quick-input-message')!;
		assert.strictEqual(message.textContent, `${prompt} (Press 'Enter' to confirm or 'Escape' to cancel)`);
		assert.strictEqual(message.childElementCount, 0);
		assert.deepStrictEqual(openedLinks, []);
	});

	test('prompt mode keeps nonempty validation links and restores plain text when cleared', () => {
		const input = store.add(controller.createInputBox());
		input.prompt = '[prompt](command:owned.prompt)';
		input.promptIsPlainText = true;
		input.validationMessage = '[validation](command:owned.validation)';
		input.show();
		const message = fixture.querySelector<HTMLElement>('.quick-input-message')!;
		message.querySelector<HTMLAnchorElement>('a')!.click();
		assert.deepStrictEqual(openedLinks, ['command:owned.validation']);
		for (const cleared of [undefined, '']) {
			input.validationMessage = cleared;
			assert.strictEqual(message.textContent, '[prompt](command:owned.prompt) (Press \'Enter\' to confirm or \'Escape\' to cancel)');
			assert.strictEqual(message.childElementCount, 0);
		}
	});

	test('prompt mode invalidates rendering when only the mode or message owner changes', () => {
		const input = store.add(controller.createInputBox());
		input.prompt = '[same text](command:owned.prompt)';
		input.promptIsPlainText = true;
		input.show();
		const message = fixture.querySelector<HTMLElement>('.quick-input-message')!;
		const text = '[same text](command:owned.prompt) (Press \'Enter\' to confirm or \'Escape\' to cancel)';
		for (const plain of [false, true, false, true]) {
			input.promptIsPlainText = plain;
			assert.strictEqual(!!message.querySelector('a'), !plain);
			if (plain) {
				assert.strictEqual(message.textContent, text);
			}
		}
		input.validationMessage = text;
		assert.ok(message.querySelector('a'));
		input.validationMessage = undefined;
		assert.strictEqual(message.textContent, text);
		assert.strictEqual(message.childElementCount, 0);
	});

	test('prompt mode survives re-show and controller input preserves accept, password and cancellation', async () => {
		const input = store.add(controller.createInputBox());
		input.prompt = '[repeat](command:owned.prompt)';
		input.promptIsPlainText = true;
		input.show();
		input.hide();
		input.show();
		assert.strictEqual(fixture.querySelector('.quick-input-message')!.childElementCount, 0);
		input.hide();
		const shown = setupWaitTilShownListener(controller);
		const accepted = controller.input({ prompt: input.prompt, promptIsPlainText: true, password: true, value: 'owned response' });
		await shown;
		assert.strictEqual(fixture.querySelector('.quick-input-message')!.childElementCount, 0);
		assert.strictEqual(fixture.querySelector('input')!.type, 'password');
		controller.accept();
		assert.strictEqual(await accepted, 'owned response');
		assert.strictEqual(controller.isVisible(), false);
		const cts = store.add(new CancellationTokenSource());
		const cancelled = controller.input({ prompt: input.prompt, promptIsPlainText: true }, cts.token);
		cts.cancel();
		assert.strictEqual(await cancelled, undefined);
		assert.strictEqual(controller.isVisible(), false);
		const alreadyCancelled = controller.input({ prompt: input.prompt, promptIsPlainText: true }, cts.token);
		assert.strictEqual(await alreadyCancelled, undefined);
		assert.strictEqual(controller.isVisible(), false);
	});

	test('input enabled getter follows the readonly attribute', () => {
		const input = store.add(new QuickInputBox(fixture, unthemedInboxStyles, unthemedToggleStyles));
		assert.strictEqual(input.enabled, true);
		for (const enabled of [false, true, false]) {
			input.enabled = enabled;
			assert.strictEqual(input.enabled, enabled);
			assert.strictEqual(fixture.querySelector('input')!.hasAttribute('readonly'), !enabled);
		}
	});

	test('controller focus follows enabled and disabled input state', () => {
		const quickpick = store.add(controller.createQuickPick());
		quickpick.items = [{ label: 'owned focus item' }];
		quickpick.show();
		const input = fixture.querySelector('input')!;
		for (const enabled of [true, false, true]) {
			quickpick.enabled = enabled;
			input.blur();
			controller.focus();
			assert.strictEqual(input.hasAttribute('readonly'), !enabled);
			assert.strictEqual(mainWindow.document.activeElement === input, enabled);
		}
	});

	test('close motion requires modern UI with motion enabled', () => {
		const clock = sinon.useFakeTimers();
		const quickpick = store.add(controller.createQuickPick());
		const widget = fixture.querySelector<HTMLElement>('.quick-input-widget')!;
		const states: { display: string; closing: boolean; inert: boolean; visible: boolean }[] = [];
		const recordState = () => states.push({
			display: widget.style.display,
			closing: widget.classList.contains('quick-input-widget-closing'),
			inert: widget.inert,
			visible: controller.isVisible(),
		});

		fixture.classList.add('style-override', 'monaco-reduce-motion');
		quickpick.show();
		quickpick.hide();
		recordState();

		fixture.classList.replace('monaco-reduce-motion', 'monaco-enable-motion');
		quickpick.show();
		quickpick.hide();
		recordState();

		quickpick.show();
		recordState();

		quickpick.hide();
		clock.tick(150);
		recordState();

		assert.deepStrictEqual(states, [
			{ display: 'none', closing: false, inert: false, visible: false },
			{ display: '', closing: true, inert: true, visible: false },
			{ display: '', closing: false, inert: false, visible: true },
			{ display: 'none', closing: false, inert: false, visible: false },
		]);
	});

	test('overlay picker aligns its input with the anchor and bypasses motion', () => {
		fixture.style.width = '600px';
		fixture.style.height = '400px';
		fixture.classList.add('style-override', 'monaco-enable-motion');
		controller.layout({ width: 600, height: 400 }, 0);

		const anchor = document.createElement('div');
		anchor.style.position = 'absolute';
		anchor.style.left = '80px';
		anchor.style.top = '40px';
		anchor.style.width = '300px';
		anchor.style.height = '26px';
		fixture.appendChild(anchor);

		const quickpick = store.add(controller.createQuickPick());
		quickpick.anchor = anchor;
		quickpick.anchorPosition = 'overlay';
		quickpick.show();

		const widget = fixture.querySelector<HTMLElement>('.quick-input-widget')!;
		const input = fixture.querySelector<HTMLElement>('.quick-input-filter .monaco-inputbox')!;
		const anchorRect = anchor.getBoundingClientRect();
		const inputRect = input.getBoundingClientRect();
		const openState = {
			alignmentDelta: {
				left: inputRect.left - anchorRect.left,
				top: inputRect.top - anchorRect.top,
				width: inputRect.width - anchorRect.width,
				height: inputRect.height - anchorRect.height,
			},
			animationName: mainWindow.getComputedStyle(widget).animationName,
			overlay: widget.classList.contains('quick-input-widget-overlay'),
		};

		quickpick.hide();

		assert.deepStrictEqual({
			openState,
			closeState: {
				display: widget.style.display,
				closing: widget.classList.contains('quick-input-widget-closing'),
				inert: widget.inert,
			},
		}, {
			openState: {
				alignmentDelta: { left: 0, top: 0, width: 0, height: 0 },
				animationName: 'none',
				overlay: true,
			},
			closeState: {
				display: 'none',
				closing: false,
				inert: false,
			},
		});
	});

	test('pick - basecase', async () => {
		const item = { label: 'foo' };

		const wait = setupWaitTilShownListener(controller);
		const pickPromise = controller.pick([item, { label: 'bar' }]);
		await wait;

		controller.accept();
		const pick = await raceTimeout(pickPromise, 2000);

		assert.strictEqual(pick, item);
	});

	test('pick - activeItem is honored', async () => {
		const item = { label: 'foo' };

		const wait = setupWaitTilShownListener(controller);
		const pickPromise = controller.pick([{ label: 'bar' }, item], { activeItem: item });
		await wait;

		controller.accept();
		const pick = await pickPromise;

		assert.strictEqual(pick, item);
	});

	test('input - basecase', async () => {
		const wait = setupWaitTilShownListener(controller);
		const inputPromise = controller.input({ value: 'foo' });
		await wait;

		controller.accept();
		const value = await raceTimeout(inputPromise, 2000);

		assert.strictEqual(value, 'foo');
	});

	test('onDidChangeValue - gets triggered when .value is set', async () => {
		const quickpick = store.add(controller.createQuickPick());

		let value: string | undefined = undefined;
		store.add(quickpick.onDidChangeValue((e) => value = e));

		// Trigger a change
		quickpick.value = 'changed';

		try {
			assert.strictEqual(value, quickpick.value);
		} finally {
			quickpick.dispose();
		}
	});

	test('keepScrollPosition - works with activeItems', async () => {
		const quickpick = store.add(controller.createQuickPick() as QuickPick<IQuickPickItem>);

		const items = [];
		for (let i = 0; i < 1000; i++) {
			items.push({ label: `item ${i}` });
		}
		quickpick.items = items;
		// setting the active item should cause the quick pick to scroll to the bottom
		quickpick.activeItems = [items[items.length - 1]];
		quickpick.show();

		const cursorTop = quickpick.scrollTop;

		assert.notStrictEqual(cursorTop, 0);

		quickpick.keepScrollPosition = true;
		quickpick.activeItems = [items[0]];
		assert.strictEqual(cursorTop, quickpick.scrollTop);

		quickpick.keepScrollPosition = false;
		quickpick.activeItems = [items[0]];
		assert.strictEqual(quickpick.scrollTop, 0);
	});

	test('keepScrollPosition - works with items', async () => {
		const quickpick = store.add(controller.createQuickPick() as QuickPick<IQuickPickItem>);

		const items = [];
		for (let i = 0; i < 1000; i++) {
			items.push({ label: `item ${i}` });
		}
		quickpick.items = items;
		// setting the active item should cause the quick pick to scroll to the bottom
		quickpick.activeItems = [items[items.length - 1]];
		quickpick.show();

		const cursorTop = quickpick.scrollTop;
		assert.notStrictEqual(cursorTop, 0);

		quickpick.keepScrollPosition = true;
		quickpick.items = items;
		assert.strictEqual(cursorTop, quickpick.scrollTop);

		quickpick.keepScrollPosition = false;
		quickpick.items = items;
		assert.strictEqual(quickpick.scrollTop, 0);
	});

	test('selectedItems - verify previous selectedItems does not hang over to next set of items', async () => {
		const quickpick = store.add(controller.createQuickPick());
		quickpick.items = [{ label: 'step 1' }];
		quickpick.show();

		void (await new Promise<void>(resolve => {
			store.add(quickpick.onDidAccept(() => {
				quickpick.canSelectMany = true;
				quickpick.items = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
				resolve();
			}));

			// accept 'step 1'
			controller.accept();
		}));

		// accept in multi-select
		controller.accept();

		// Since we don't select any items, the selected items should be empty
		assert.strictEqual(quickpick.selectedItems.length, 0);
	});

	test('activeItems - verify onDidChangeActive is triggered after setting items', async () => {
		const quickpick = store.add(controller.createQuickPick());

		// Setup listener for verification
		const activeItemsFromEvent: IQuickPickItem[] = [];
		store.add(quickpick.onDidChangeActive(items => activeItemsFromEvent.push(...items)));

		quickpick.show();

		const item = { label: 'step 1' };
		quickpick.items = [item];

		assert.strictEqual(activeItemsFromEvent.length, 1);
		assert.strictEqual(activeItemsFromEvent[0], item);
		assert.strictEqual(quickpick.activeItems.length, 1);
		assert.strictEqual(quickpick.activeItems[0], item);
	});

	test('activeItems - verify setting itemActivation to None still triggers onDidChangeActive after selection #207832', async () => {
		const quickpick = store.add(controller.createQuickPick());
		const item = { label: 'step 1' };
		quickpick.items = [item];
		quickpick.show();
		assert.strictEqual(quickpick.activeItems[0], item);

		// Setup listener for verification
		const activeItemsFromEvent: IQuickPickItem[] = [];
		store.add(quickpick.onDidChangeActive(items => activeItemsFromEvent.push(...items)));

		// Trigger a change
		quickpick.itemActivation = ItemActivation.NONE;
		quickpick.items = [item];

		assert.strictEqual(activeItemsFromEvent.length, 0);
		assert.strictEqual(quickpick.activeItems.length, 0);
	});

	test('isKeyModified - returns false when no modifiers are pressed', () => {
		assert.strictEqual(isKeyModified(NO_KEY_MODS), false);
		assert.strictEqual(isKeyModified({ ctrlCmd: false, alt: false, shift: false }), false);
	});


	for (const removeInitialItem of [false, true]) {
		test(`candidate - initial active item ${removeInitialItem ? 'removed stays absent' : 'retained restores normally'}`, async () => {
			fixture.style.width = '600px';
			fixture.style.height = '400px';
			controller.layout({ height: 400, width: 600 }, 0);
			assert.ok(fixture.clientWidth > 0 && fixture.clientHeight > 0);
			const button = { iconClass: 'fixture-remove-action', tooltip: 'Remove fixture item', alwaysVisible: true };
			const item: IQuickPickItem = { label: 'Alpha', buttons: [button] };
			const create = sinon.spy(controller, 'createQuickPick');
			let removals = 0;
			let settlements = 0;
			const activeEvents: string[][] = [];
			const selectionEvents: string[][] = [];
			const pickPromise = controller.pick([item], {
				activeItem: item,
				value: 'Alpha',
				onDidTriggerItemButton: event => {
					assert.strictEqual(event.item, item);
					assert.strictEqual(event.button, button);
					removals++;
					event.removeItem();
				}
			});
			const observed = pickPromise.then(value => {
				settlements++;
				return { ok: true as const, value };
			}, error => {
				settlements++;
				return { ok: false as const, error };
			});
			const unwrapOutcome = (outcome: Awaited<typeof observed>) => {
				if (!outcome.ok) { throw outcome.error; }
				return outcome.value;
			};
			assert.strictEqual(create.callCount, 1);
			const picker = create.returnValues[0] as QuickPick<IQuickPickItem>;
			store.add(picker.onDidChangeActive(items => activeEvents.push(items.map(value => value.label))));
			store.add(picker.onDidChangeSelection(items => selectionEvents.push(items.map(value => value.label))));
			try {
				const untilReady = Date.now() + 2000;
				while (picker.busy || picker.items.length !== 1 || picker.activeItems[0] !== item) {
					assert.ok(Date.now() < untilReady, 'Real picker did not finish initial items/activeItem assignment');
					await new Promise<void>(resolve => setTimeout(resolve, 10));
				}
				assert.strictEqual(picker.items[0], item);
				assert.deepStrictEqual(picker.activeItems, [item]);
				const action = fixture.querySelectorAll<HTMLElement>('.quick-input-list-entry .action-label.fixture-remove-action');
				assert.strictEqual(action.length, 1, 'Real item button must be uniquely rendered');
				const scrollBefore = picker.keepScrollPosition;
				if (removeInitialItem) {
					action[0].click();
					assert.strictEqual(removals, 1);
					assert.deepStrictEqual(picker.items, []);
					assert.deepStrictEqual(picker.activeItems, []);
					assert.strictEqual(picker.keepScrollPosition, scrollBefore);
					assert.strictEqual(fixture.querySelectorAll('.quick-input-list-entry').length, 0);
				}
				const input = fixture.querySelector<HTMLInputElement>('.quick-input-filter input');
				assert.ok(input, 'Real input element must exist');
				input.value = '';
				input.dispatchEvent(new InputEvent('input', { bubbles: true }));
				assert.strictEqual(picker.value, '');
				assert.deepStrictEqual(picker.items, removeInitialItem ? [] : [item]);
				assert.deepStrictEqual(picker.activeItems, removeInitialItem ? [] : [item]);
				controller.accept();
				await new Promise<void>(resolve => setTimeout(resolve, 20));
				if (removeInitialItem) {
					assert.strictEqual(settlements, 0, 'Empty picker must not resolve the removed initial item');
					assert.strictEqual(fixture.querySelector<HTMLElement>('.quick-input-widget')!.style.display, '');
				} else {
					const outcome = await observed;
					assert.strictEqual(unwrapOutcome(outcome), item);
					assert.strictEqual(settlements, 1);
				}
			} finally {
				controller.hide();
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					const outcome = await Promise.race([observed, new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error('Owned hide did not settle original public pick promise')), 1500);
					})]);
					assert.strictEqual(unwrapOutcome(outcome), removeInitialItem ? undefined : item);
					assert.strictEqual(settlements, 1);
				} finally {
					if (timeout !== undefined) { clearTimeout(timeout); }
				}
			}
		});
	}


	for (const initiallyDisabled of [false, true]) {
		test(`QuickTree - disabled ${initiallyDisabled ? 'before show' : 'after show'} blocks checkbox changes and can be re-enabled`, async () => {
			controller.layout({ height: 600, width: 800 }, 0);
			const tree = store.add(controller.createQuickTree());
			const item = { label: 'Disabled tree leaf', checked: false };
			tree.ignoreFocusOut = true;
			tree.setItemTree([item]);
			let checkboxEvents = 0;
			let checkedEvents = 0;
			store.add(tree.onDidChangeCheckboxState(() => checkboxEvents++));
			store.add(tree.onDidChangeCheckedLeafItems(() => checkedEvents++));
			if (initiallyDisabled) {
				tree.enabled = false;
			}
			tree.show();
			await new Promise<void>(resolve => setTimeout(resolve, 10));
			tree.enabled = false;
			const checkbox = fixture.querySelector<HTMLElement>('.quick-input-tree-entry > .monaco-checkbox[role="checkbox"]');
			assert.ok(checkbox, 'The rendered child checkbox must exist');
			checkbox.click();
			assert.deepStrictEqual(tree.checkedLeafItems, []);
			assert.deepStrictEqual({ checkboxEvents, checkedEvents }, { checkboxEvents: 0, checkedEvents: 0 });
			assert.strictEqual(checkbox.getAttribute('aria-disabled'), 'true');
			assert.strictEqual(checkbox.tabIndex, -1);
			tree.enabled = true;
			const enabledCheckbox = fixture.querySelector<HTMLElement>('.quick-input-tree-entry > .monaco-checkbox[role="checkbox"]');
			assert.ok(enabledCheckbox);
			enabledCheckbox.click();
			assert.deepStrictEqual(tree.checkedLeafItems, [item]);
			assert.deepStrictEqual({ checkboxEvents, checkedEvents }, { checkboxEvents: 1, checkedEvents: 1 });
			assert.strictEqual(enabledCheckbox.getAttribute('aria-disabled'), 'false');
			assert.strictEqual(enabledCheckbox.tabIndex, 0);
		});
	}

	test('QuickTree - re-enabling the tree preserves a disabled item', async () => {
		controller.layout({ height: 600, width: 800 }, 0);
		const tree = store.add(controller.createQuickTree());
		const item = { label: 'Individually disabled leaf', checked: false, disabled: true };
		tree.ignoreFocusOut = true;
		tree.setItemTree([item]);
		let checkboxEvents = 0;
		store.add(tree.onDidChangeCheckboxState(() => checkboxEvents++));
		tree.show();
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		tree.enabled = false;
		tree.enabled = true;
		const checkbox = fixture.querySelector<HTMLElement>('.quick-input-tree-entry > .monaco-checkbox[role="checkbox"]');
		assert.ok(checkbox);
		checkbox.click();
		assert.deepStrictEqual(tree.checkedLeafItems, []);
		assert.strictEqual(checkboxEvents, 0);
		assert.strictEqual(checkbox.getAttribute('aria-disabled'), 'true');
	});

	test('QuickTree - disabled tree accepts new data without enabling its checkbox', async () => {
		controller.layout({ height: 600, width: 800 }, 0);
		const tree = store.add(controller.createQuickTree());
		tree.ignoreFocusOut = true;
		tree.setItemTree([{ label: 'Original tree leaf', checked: false }]);
		tree.show();
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		tree.enabled = false;
		const replacement = { label: 'Replacement checked leaf', checked: true };
		tree.setItemTree([replacement]);
		assert.deepStrictEqual(tree.checkedLeafItems, [replacement]);
		let checkboxEvents = 0;
		store.add(tree.onDidChangeCheckboxState(() => checkboxEvents++));
		const checkbox = fixture.querySelector<HTMLElement>('.quick-input-tree-entry > .monaco-checkbox[role="checkbox"]');
		assert.ok(checkbox);
		checkbox.click();
		assert.deepStrictEqual(tree.checkedLeafItems, [replacement]);
		assert.strictEqual(checkboxEvents, 0);
		assert.strictEqual(checkbox.getAttribute('aria-disabled'), 'true');
		tree.enabled = true;
		fixture.querySelector<HTMLElement>('.quick-input-tree-entry > .monaco-checkbox[role="checkbox"]')!.click();
		assert.deepStrictEqual(tree.checkedLeafItems, []);
		assert.strictEqual(checkboxEvents, 1);
	});

	test('QuickTree - disabled tree ignores the toggle command and resumes it when enabled', async () => {
		controller.layout({ height: 600, width: 800 }, 0);
		const tree = store.add(controller.createQuickTree());
		const item = { label: 'Command toggle leaf', checked: false };
		tree.ignoreFocusOut = true;
		tree.setItemTree([item]);
		let checkboxEvents = 0;
		store.add(tree.onDidChangeCheckboxState(() => checkboxEvents++));
		tree.show();
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		tree.reveal(item);
		assert.deepStrictEqual(tree.activeItems, [item]);
		controller.toggle();
		assert.deepStrictEqual(tree.checkedLeafItems, [item]);
		assert.strictEqual(checkboxEvents, 1);
		tree.enabled = false;
		controller.toggle();
		assert.deepStrictEqual(tree.checkedLeafItems, [item]);
		assert.strictEqual(checkboxEvents, 1);
		tree.enabled = true;
		controller.toggle();
		assert.deepStrictEqual(tree.checkedLeafItems, []);
		assert.strictEqual(checkboxEvents, 2);
	});


	async function beginDrag() {
		fixture.style.position = 'relative';
		fixture.style.width = '800px';
		fixture.style.height = '600px';
		controller.layout({ width: 800, height: 600 }, 0);
		const pick = store.add(controller.createQuickPick());
		pick.title = 'Owned drag lifecycle';
		pick.items = [{ label: 'Owned drag item' }];
		pick.ignoreFocusOut = true;
		pick.show();
		await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
		const widget = fixture.querySelector<HTMLElement>('.quick-input-widget')!;
		const title = fixture.querySelector<HTMLElement>('.quick-input-titlebar')!;
		assert.ok(widget && title);
		const rect = widget.getBoundingClientRect();
		const titleRect = title.getBoundingClientRect();
		assert.ok(rect.width > 0 && rect.height > 0 && titleRect.width > 0 && titleRect.height > 0);
		const idleMove = new mainWindow.MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1 });
		mainWindow.dispatchEvent(idleMove);
		assert.strictEqual(idleMove.defaultPrevented, false);
		const downX = titleRect.left + 10;
		const downY = titleRect.top + 6;
		title.dispatchEvent(new mainWindow.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, clientX: downX, clientY: downY, view: mainWindow }));
		const offsetX = downX - rect.left;
		const offsetY = downY - rect.top;
		const move = (left: number, top: number) => {
			const event = new mainWindow.MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: left + offsetX, clientY: top + offsetY, view: mainWindow });
			mainWindow.dispatchEvent(event);
			return event;
		};
		const end = () => mainWindow.dispatchEvent(new mainWindow.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, detail: 1, view: mainWindow }));
		return { pick, widget, move, end };
	}

	test('DnD - normal mouseup persists once and releases window listeners', async () => {
		const drag = await beginDrag();
		const writes = sinon.spy(storageService, 'store');
		const removals = sinon.spy(storageService, 'remove');
		try {
			assert.strictEqual(drag.move(20, 230).defaultPrevented, true);
			assert.strictEqual(controller.alignment.get(), 'custom');
			assert.deepStrictEqual([writes.callCount, removals.callCount], [0, 0]);
			drag.end();
			assert.deepStrictEqual([writes.callCount, removals.callCount], [1, 0]);
			const state = JSON.parse(storageService.get('workbench.quickInput.viewState', StorageScope.APPLICATION)!);
			assert.ok(Number.isFinite(state.top) && Number.isFinite(state.left));
			assert.strictEqual(drag.move(60, 300).defaultPrevented, false);
			assert.strictEqual(writes.callCount, 1);
		} finally {
			drag.end();
			drag.pick.hide();
		}
	});

	test('DnD - hide cancels the in-flight gesture before mouseup', async () => {
		const drag = await beginDrag();
		const writes = sinon.spy(storageService, 'store');
		try {
			assert.strictEqual(drag.move(20, 230).defaultPrevented, true);
			assert.strictEqual(writes.callCount, 0);
			drag.pick.hide();
			const before = controller.alignment.get();
			assert.deepStrictEqual({ prevented: drag.move(60, 300).defaultPrevented, visible: controller.isVisible(), alignment: controller.alignment.get(), writes: writes.callCount },
				{ prevented: false, visible: false, alignment: before, writes: 0 });
			drag.end();
			assert.strictEqual(writes.callCount, 0);
		} finally {
			drag.end();
			drag.pick.hide();
		}
	});

	test('DnD - controller disposal releases its active window gesture', async () => {
		const drag = await beginDrag();
		try {
			assert.strictEqual(drag.move(20, 230).defaultPrevented, true);
			controller.dispose();
			assert.strictEqual(drag.move(60, 300).defaultPrevented, false);
		} finally {
			drag.end();
			controller.dispose();
		}
	});

	test('DnD - anchored replacement cancels the previous window gesture', async () => {
		const drag = await beginDrag();
		try {
			assert.strictEqual(drag.move(20, 230).defaultPrevented, true);
			const anchor = document.createElement('div');
			anchor.style.position = 'absolute';
			anchor.style.left = '80px';
			anchor.style.top = '40px';
			anchor.style.width = '300px';
			anchor.style.height = '26px';
			fixture.appendChild(anchor);
			store.add(toDisposable(() => anchor.remove()));
			const replacement = store.add(controller.createQuickPick());
			replacement.anchor = anchor;
			replacement.anchorPosition = 'overlay';
			replacement.items = [{ label: 'Owned anchored replacement' }];
			replacement.ignoreFocusOut = true;
			replacement.show();
			await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 0));
			assert.strictEqual(controller.alignment.get(), 'custom');
			assert.strictEqual(drag.widget.classList.contains('no-drag'), true);
			const centeredLeft = Math.round(fixture.clientWidth / 2) - Math.round(drag.widget.clientWidth / 2);
			assert.deepStrictEqual({ prevented: drag.move(centeredLeft, 0).defaultPrevented, alignment: controller.alignment.get() }, { prevented: false, alignment: 'custom' });
		} finally {
			drag.end();
			controller.hide();
		}
	});

	test('isKeyModified - returns true when any modifier is pressed', () => {
		assert.strictEqual(isKeyModified({ ctrlCmd: true, alt: false, shift: false }), true);
		assert.strictEqual(isKeyModified({ ctrlCmd: false, alt: true, shift: false }), true);
		assert.strictEqual(isKeyModified({ ctrlCmd: false, alt: false, shift: true }), true);
		assert.strictEqual(isKeyModified({ ctrlCmd: true, alt: true, shift: true }), true);
	});

	for (const { name, location, toggle } of [
		{ name: 'title button', location: QuickInputButtonLocation.Title, toggle: false },
		{ name: 'inline button', location: QuickInputButtonLocation.Inline, toggle: false },
		{ name: 'input toggle', location: QuickInputButtonLocation.Input, toggle: true },
		{ name: 'default title toggle', location: undefined, toggle: true }
	]) {
		for (const mode of ['enabled', 'disabled', 'rebuilt-disabled', 'reenabled'] as const) {
			test(`Buttons - ${name} remains consistent when ${mode}`, async () => {
				const input = store.add(controller.createQuickPick());
				input.items = [{ label: 'Button item' }];
				input.ignoreFocusOut = true;
				input.title = 'Button controls';
				const tooltip = `${name} ${mode}`;
				const button: IQuickInputButton = {
					iconClass: 'codicon codicon-refresh', tooltip, location,
					...(toggle ? { toggle: { checked: false } } : {})
				};
				input.buttons = [button];
				let triggered = 0;
				store.add(input.onDidTriggerButton(event => {
					assert.strictEqual(event, button);
					triggered++;
				}));
				input.show();
				input.enabled = mode === 'enabled';
				if (mode === 'rebuilt-disabled') {
					input.buttons = [];
					input.buttons = [button];
				} else if (mode === 'reenabled') {
					input.enabled = true;
				}
				const control = fixture.querySelector<HTMLElement>(`[aria-label="${tooltip}"]`);
				assert.ok(control, 'The rendered button must have its accessible label');
				control.click();
				await Promise.resolve();
				const enabled = mode === 'enabled' || mode === 'reenabled';
				assert.strictEqual(triggered, enabled ? 1 : 0);
				if (button.toggle) {
					assert.strictEqual(button.toggle.checked, enabled);
					assert.strictEqual(control.getAttribute('aria-disabled'), enabled ? 'false' : 'true');
				}
			});
		}
	}

	for (const enabled of [true, false]) {
		test(`Buttons - OK respects enabled=${enabled}`, async () => {
			const input = store.add(controller.createQuickPick());
			input.canSelectMany = true;
			input.items = [{ label: 'OK item' }];
			input.ignoreFocusOut = true;
			let accepted = 0;
			store.add(input.onDidAccept(() => accepted++));
			input.show();
			input.enabled = enabled;
			const button = fixture.querySelector<HTMLElement>('.quick-input-action .monaco-button');
			assert.ok(button, 'The real OK button must be rendered');
			button.click();
			await Promise.resolve();
			assert.strictEqual(accepted, enabled ? 1 : 0);
		});
	}
});
