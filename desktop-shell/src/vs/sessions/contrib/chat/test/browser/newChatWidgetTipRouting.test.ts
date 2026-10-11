/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { MarkdownString, MarkdownStringTrustedOptions } from '../../../../../base/common/htmlContent.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { CHAT_SETUP_ACTION_ID } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { extractCommandIds, TIP_CATALOG } from '../../../../../workbench/contrib/chat/browser/chatTipCatalog.js';
import { IChatPetService } from '../../../../../workbench/contrib/chat/browser/chatPetService.js';
import { IChatTip, IChatTipService } from '../../../../../workbench/contrib/chat/browser/chatTipService.js';
import { IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IChatViewOptions } from '../../../../browser/parts/chatView.js';
import { IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IAgentFeedbackService } from '../../../agentFeedback/browser/agentFeedbackService.js';
import { IAquariumService } from '../../../aquarium/browser/aquariumOverlay.js';
import { NewChatInputWidget } from '../../browser/newChatInput.js';
import { ISessionModelSelectionState, normalizeModelPickerOptions } from '../../browser/sessionModelSelectionModel.js';
import { NewChatWidget } from '../../browser/newChatWidget.js';
import { WorkspacePicker } from '../../browser/sessionWorkspacePicker.js';
import { WebWorkspacePicker } from '../../browser/webWorkspacePicker.js';

suite('NewChatWidget tip origin routing', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const modelCommand = 'workbench.action.chat.openModelPicker';
	const planCommand = 'workbench.action.chat.openPlan';

	function catalogTip(id: string, trusted?: boolean | MarkdownStringTrustedOptions): IChatTip {
		const definition = TIP_CATALOG.find(tip => tip.id === id)!;
		assert.ok(definition);
		const content = definition.buildMessage({
			keybindingService: new class extends mock<IKeybindingService>() {
				override lookupKeybinding() { return undefined; }
			}(),
			experimentalTipMessages: new Map(),
		});
		const enabledCommands = extractCommandIds(content.value);
		content.isTrusted = trusted ?? { enabledCommands };
		return { id, content, enabledCommands };
	}

	function createRouting(setup?: DeferredPromise<boolean>) {
		const executed: string[] = [];
		const commands = new class extends mock<ICommandService>() {
			override readonly onWillExecuteCommand = Event.None;
			override readonly onDidExecuteCommand = Event.None;
			override async executeCommand<T>(id: string): Promise<T> {
				executed.push(id);
				return (id === CHAT_SETUP_ACTION_ID && setup ? await setup.p : undefined) as T;
			}
		}();
		// Real ordering, real CommandOpener and real allowCommands enforcement.
		const opener = new OpenerService(new class extends mock<ICodeEditorService>() { }(), commands);
		return { opener, commands, executed, needsSetup: setup !== undefined };
	}

	function createComposer(tip: IChatTip, routing: ReturnType<typeof createRouting>) {
		const services = disposables.add(new TestInstantiationService(undefined, true, undefined, true));
		const context = new MockContextKeyService();
		context.createKey(ChatContextKeys.foregroundSessionCount.key, 0);
		const inputState: ISessionModelSelectionState = {
			currentModel: undefined, pendingSelection: undefined, models: [],
			options: normalizeModelPickerOptions(undefined), hasSelectableModel: false,
		};
		let pickerOpens = 0;
		const picker = { dispose: () => { }, onDidSelectWorkspace: Event.None };
		services.stubInstance(WorkspacePicker, picker);
		services.stubInstance(WebWorkspacePicker, picker);
		services.stubInstance(NewChatInputWidget, {
			dispose: () => { }, saveState: () => { }, focus: () => { },
			openModelPicker: () => { pickerOpens++; },
			selectedModelState: constObservable(inputState),
			sessionTypePicker: { onDidSelectSessionType: Event.None } as NewChatInputWidget['sessionTypePicker'],
		});
		services.stub(IContextKeyService, context);
		services.stub(IContextMenuService, {});
		services.stub(IMenuService, {});
		services.stub(IConfigurationService, { onDidChangeConfiguration: Event.None });
		services.stub(ILogService, new NullLogService());
		services.stub(ISessionsManagementService, { onDidSendRequest: Event.None, onDidFailBackgroundSend: Event.None });
		services.stub(ISessionsService, { activeSession: observableValue<IActiveSession | undefined>('session', undefined) });
		services.stub(IAquariumService, {});
		services.stub(IAgentHostFilterService, {});
		services.stub(IUriIdentityService, {});
		services.stub(IAgentFeedbackService, { onDidChangeFeedback: Event.None, getFeedback: () => [] });
		services.stub(IChatPetService, {});
		services.stub(IChatTipService, {
			onDidDismissTip: Event.None, onDidNavigateTip: Event.None,
			onDidHideTip: Event.None, onDidDisableTips: Event.None,
			getWelcomeTip: () => tip, resetSession: () => { }, hasMultipleTips: () => false,
		});
		services.stub(IChatEntitlementService, { hasByokModels: !routing.needsSetup, sentiment: { completed: false } });
		services.stub(ICommandService, routing.commands);
		services.stub(IOpenerService, routing.opener);
		services.stub(ILanguageService, {});
		services.stub(IHoverService, {
			setupManagedHover: () => ({ dispose: () => { }, show: () => { }, hide: () => { }, update: () => { } }),
		});
		services.stub(IMarkdownRendererService, new MarkdownRendererService(routing.opener));
		// Stub unrelated toolbar chrome; keep the actual widget, tip, renderer,
		// markdown event listener and global opener implementations.
		services.stubInstance(MenuWorkbenchToolBar, { dispose: () => { } });
		const widget = disposables.add(services.createInstance(NewChatWidget, {
			renderSessionTypePickerInControls: constObservable(false),
		} as IChatViewOptions));
		const host = document.createElement('div');
		document.body.appendChild(host);
		disposables.add(toDisposable(() => host.remove()));
		const container = host.appendChild(document.createElement('div'));
		// Mount just the tip boundary, avoiding editors/providers. Do not replace
		// _renderChatTip: unlike the existing model-tip helper, execute its real body.
		Reflect.set(widget, '_chatTipContainer', container);
		(Reflect.get(widget, '_renderChatTip') as () => void).call(widget);
		function link(command: string): HTMLAnchorElement {
			const anchor = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-href]'))
				.find(anchor => anchor.dataset.href === `command:${command}`);
			assert.ok(anchor, `actual rendered link for ${command}`);
			return anchor;
		}
		return { widget, container, link, get pickerOpens() { return pickerOpens; } };
	}

	async function click(anchor: HTMLAnchorElement): Promise<void> {
		anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
		await timeout(0);
	}

	test('each composer owns its model-tip click and disposing the latest leaves the other independent', async () => {
		const routing = createRouting();
		const first = createComposer(catalogTip('tip.switchToAuto'), routing);
		const second = createComposer(catalogTip('tip.switchToAuto'), routing);
		await click(first.link(modelCommand));
		assert.deepStrictEqual([first.pickerOpens, second.pickerOpens], [1, 0]);
		const secondAnchor = second.link(modelCommand);
		await click(secondAnchor);
		assert.deepStrictEqual([first.pickerOpens, second.pickerOpens], [1, 1]);
		second.widget.dispose();
		await click(first.link(modelCommand));
		await click(secondAnchor);
		assert.deepStrictEqual([first.pickerOpens, second.pickerOpens], [2, 1]);
		assert.deepStrictEqual(routing.executed, []);
	});

	test('both Plan-tip clicks remain local no-ops while ordinary open requests keep CommandOpener routing', async () => {
		const routing = createRouting();
		const first = createComposer(catalogTip('tip.planMode'), routing);
		const second = createComposer(catalogTip('tip.planMode'), routing);
		await click(first.link(planCommand));
		await click(second.link(planCommand));
		assert.deepStrictEqual(routing.executed, []);
		assert.deepStrictEqual([first.pickerOpens, second.pickerOpens], [0, 0]);
		await routing.opener.open(`command:${planCommand}`, { allowCommands: true });
		assert.deepStrictEqual(routing.executed, [planCommand]);
	});

	test('the local callback obeys enabledCommands and other trusted tip commands retain their default route', async () => {
		const routing = createRouting();
		const ordinaryCommand = 'workbench.action.chat.nextTip';
		const blocked = createComposer(catalogTip('tip.switchToAuto', { enabledCommands: [ordinaryCommand] }), routing);
		await click(blocked.link(modelCommand));
		assert.strictEqual(blocked.pickerOpens, 0);
		assert.deepStrictEqual(routing.executed, []);
		const ordinary = createComposer({
			id: 'ordinary-command-control',
			content: new MarkdownString(`[next](command:${ordinaryCommand})`, { isTrusted: { enabledCommands: [ordinaryCommand] } }),
		}, routing);
		await click(ordinary.link(ordinaryCommand));
		assert.deepStrictEqual(routing.executed, [ordinaryCommand]);
		await routing.opener.open(`command:${modelCommand}`, { allowCommands: false });
		assert.strictEqual(blocked.pickerOpens, 0);
		assert.strictEqual(ordinary.pickerOpens, 0);
		assert.deepStrictEqual(routing.executed, [ordinaryCommand]);
	});

	test('a click awaiting setup cannot dispatch to another composer after its originating part is disposed', async () => {
		const setup = new DeferredPromise<boolean>();
		const routing = createRouting(setup);
		const first = createComposer(catalogTip('tip.switchToAuto'), routing);
		const second = createComposer(catalogTip('tip.switchToAuto'), routing);
		await click(first.link(modelCommand));
		assert.deepStrictEqual(routing.executed, [CHAT_SETUP_ACTION_ID]);
		first.widget.dispose();
		await setup.complete(true);
		await timeout(0);
		assert.deepStrictEqual([first.pickerOpens, second.pickerOpens], [0, 0]);
		assert.deepStrictEqual(routing.executed, [CHAT_SETUP_ACTION_ID]);
	});
});
