/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IChatPetService } from '../../../../../workbench/contrib/chat/browser/chatPetService.js';
import { IChatTipService } from '../../../../../workbench/contrib/chat/browser/chatTipService.js';
import { IChatViewOptions } from '../../../../browser/parts/chatView.js';
import { IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { IOpenNewSessionResult, ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IAgentFeedbackService } from '../../../agentFeedback/browser/agentFeedbackService.js';
import { IAquariumService } from '../../../aquarium/browser/aquariumOverlay.js';
import { NewChatInputWidget } from '../../browser/newChatInput.js';
import { ISessionModelSelectionState, normalizeModelPickerOptions } from '../../browser/sessionModelSelectionModel.js';
import { IPreferredSessionType } from '../../browser/sessionTypePicker.js';
import { NewChatWidget } from '../../browser/newChatWidget.js';
import { WorkspacePicker } from '../../browser/sessionWorkspacePicker.js';
import { WebWorkspacePicker } from '../../browser/webWorkspacePicker.js';

interface INewChatWidgetHarness {
	readonly _pendingPreferredUpgrade: MutableDisposable<IDisposable>;
	readonly _newSessionCreation: MutableDisposable<IDisposable>;
	readonly sessionsManagementService: { readonly onDidChangeSessionTypes: Event<void> };
	readonly sessionsService: { unsetNewSession(): void };
	readonly _session: IObservable<IActiveSession | undefined>;
	readonly _newChatInput: {
		readonly sessionTypePicker: {
			getUserPickedSessionType(): IPreferredSessionType | undefined;
			getPreferredSessionType(folderUri: URI): IPreferredSessionType | undefined;
		};
	};
	_isPreferredServable(folderUri: URI, pick: IPreferredSessionType): boolean;
	_createSessionNow(folderUri: URI, userPick: IPreferredSessionType | undefined, token: CancellationToken): Promise<IOpenNewSessionResult>;
	_createNewSession(folderUri: URI): Promise<IOpenNewSessionResult>;
	_onWorkspaceSelected(folderUri: URI | undefined): Promise<void>;
	_scheduleRecreateOnProviderChange(folderUri: URI, userPick: IPreferredSessionType | undefined, created: ISession | undefined, replayMissedChange: boolean): void;
	_recreateOnProviderChange(folderUri: URI, userPick: IPreferredSessionType | undefined, created: ISession | undefined): void;
}

const createNewSession = Reflect.get(NewChatWidget.prototype, '_createNewSession') as (
	this: INewChatWidgetHarness,
	folderUri: URI,
) => Promise<IOpenNewSessionResult>;
const scheduleRecreateOnProviderChange = Reflect.get(NewChatWidget.prototype, '_scheduleRecreateOnProviderChange') as INewChatWidgetHarness['_scheduleRecreateOnProviderChange'];
const recreateOnProviderChange = Reflect.get(NewChatWidget.prototype, '_recreateOnProviderChange') as INewChatWidgetHarness['_recreateOnProviderChange'];
const onWorkspaceSelected = Reflect.get(NewChatWidget.prototype, '_onWorkspaceSelected') as INewChatWidgetHarness['_onWorkspaceSelected'];

function createHarness(
	pendingPreferredUpgrade: MutableDisposable<IDisposable>,
	newSessionCreation: MutableDisposable<IDisposable>,
	onDidChangeSessionTypes: Event<void>,
	createSessionNow: (token: CancellationToken) => Promise<IOpenNewSessionResult>,
): INewChatWidgetHarness {
	const harness: INewChatWidgetHarness = {
		_pendingPreferredUpgrade: pendingPreferredUpgrade,
		_newSessionCreation: newSessionCreation,
		sessionsManagementService: { onDidChangeSessionTypes },
		sessionsService: { unsetNewSession: () => { } },
		_session: observableValue<IActiveSession | undefined>('session', undefined),
		_newChatInput: {
			sessionTypePicker: {
				getUserPickedSessionType: () => undefined,
				getPreferredSessionType: () => undefined,
			},
		},
		_isPreferredServable: () => false,
		_createSessionNow: (_folderUri, _userPick, token) => createSessionNow(token),
		_createNewSession: folderUri => createNewSession.call(harness, folderUri),
		_onWorkspaceSelected: folderUri => onWorkspaceSelected.call(harness, folderUri),
		_scheduleRecreateOnProviderChange: (folderUri, userPick, created, replayMissedChange) => scheduleRecreateOnProviderChange.call(harness, folderUri, userPick, created, replayMissedChange),
		_recreateOnProviderChange: (folderUri, userPick, created) => recreateOnProviderChange.call(harness, folderUri, userPick, created),
	};
	return harness;
}

suite('NewChatWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('replays a provider change that arrives while creating the draft', async () => {
		const sessionTypesChanged = disposables.add(new Emitter<void>());
		const pendingPreferredUpgrade = disposables.add(new MutableDisposable<IDisposable>());
		const newSessionCreation = disposables.add(new MutableDisposable<IDisposable>());
		const folder = URI.file('/project');
		const firstCreation = new DeferredPromise<IOpenNewSessionResult>();
		let createCount = 0;
		const harness = createHarness(pendingPreferredUpgrade, newSessionCreation, sessionTypesChanged.event, () => {
			createCount++;
			return createCount === 1
				? firstCreation.p
				: Promise.resolve({ session: undefined, trustDeclined: true });
		});

		const creating = harness._createNewSession(folder);
		sessionTypesChanged.fire();
		firstCreation.complete({ session: undefined, trustDeclined: false });
		await creating;

		assert.strictEqual(createCount, 2);
	});

	test('waits for another provider change after creation fails', async () => {
		const sessionTypesChanged = disposables.add(new Emitter<void>());
		const pendingPreferredUpgrade = disposables.add(new MutableDisposable<IDisposable>());
		const newSessionCreation = disposables.add(new MutableDisposable<IDisposable>());
		let createCount = 0;
		const harness = createHarness(pendingPreferredUpgrade, newSessionCreation, sessionTypesChanged.event, async () => {
			createCount++;
			return { session: undefined, trustDeclined: false };
		});

		await harness._createNewSession(URI.file('/project'));
		const countBeforeChange = createCount;
		sessionTypesChanged.fire();

		assert.deepStrictEqual({ countBeforeChange, countAfterChange: createCount }, { countBeforeChange: 1, countAfterChange: 2 });
	});

	test('clearing the workspace cancels creation and does not rearm a provider upgrade', async () => {
		const sessionTypesChanged = disposables.add(new Emitter<void>());
		const pendingPreferredUpgrade = disposables.add(new MutableDisposable<IDisposable>());
		const newSessionCreation = disposables.add(new MutableDisposable<IDisposable>());
		const result = new DeferredPromise<IOpenNewSessionResult>();
		const tokens: CancellationToken[] = [];
		const harness = createHarness(pendingPreferredUpgrade, newSessionCreation, sessionTypesChanged.event, token => {
			tokens.push(token);
			return result.p;
		});
		let unsetCount = 0;
		harness.sessionsService.unsetNewSession = () => unsetCount++;
		const creating = harness._createNewSession(URI.file('/project'));
		await harness._onWorkspaceSelected(undefined);
		const cancelledOnClear = tokens[0].isCancellationRequested;
		await result.complete({ session: undefined, trustDeclined: false });
		await creating;

		assert.deepStrictEqual({ cancelledOnClear, unsetCount, upgradeRearmed: pendingPreferredUpgrade.value !== undefined }, {
			cancelledOnClear: true,
			unsetCount: 1,
			upgradeRearmed: false,
		});
	});

	test('cancels an in-flight creation when a newer one starts', async () => {
		const sessionTypesChanged = disposables.add(new Emitter<void>());
		const pendingPreferredUpgrade = disposables.add(new MutableDisposable<IDisposable>());
		const newSessionCreation = disposables.add(new MutableDisposable<IDisposable>());
		const firstCreation = new DeferredPromise<IOpenNewSessionResult>();
		const tokens: CancellationToken[] = [];
		const harness = createHarness(pendingPreferredUpgrade, newSessionCreation, sessionTypesChanged.event, token => {
			tokens.push(token);
			return tokens.length === 1
				? firstCreation.p
				: Promise.resolve({ session: undefined, trustDeclined: true });
		});

		const first = harness._createNewSession(URI.file('/first'));
		const second = harness._createNewSession(URI.file('/second'));
		const firstCancelledWhenSecondStarted = tokens[0].isCancellationRequested;
		firstCreation.complete({ session: undefined, trustDeclined: false });
		await Promise.all([first, second]);

		assert.deepStrictEqual({ tokenCount: tokens.length, firstCancelledWhenSecondStarted }, { tokenCount: 2, firstCancelledWhenSecondStarted: true });
	});
});

suite('NewChatWidget model tips', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function modelState(identifier: string | undefined): ISessionModelSelectionState {
		return {
			currentModel: identifier === undefined ? undefined : {
				identifier,
				metadata: {
					extension: new ExtensionIdentifier('test.model'),
					name: identifier, id: identifier, vendor: 'test', version: '1', family: 'test',
					maxInputTokens: 100, maxOutputTokens: 100, isDefaultForLocation: {},
				},
			},
			pendingSelection: undefined,
			models: [],
			options: normalizeModelPickerOptions(undefined),
			hasSelectableModel: identifier !== undefined,
		};
	}

	function createWidget(initialModel: string | undefined = undefined) {
		const instantiation = disposables.add(new TestInstantiationService(undefined, true, undefined, true));
		const selectedModelState = observableValue('selectedModel', modelState(initialModel));
		const picker = { dispose: () => { }, onDidSelectWorkspace: Event.None };
		instantiation.stubInstance(WorkspacePicker, picker);
		instantiation.stubInstance(WebWorkspacePicker, picker);
		instantiation.stubInstance(NewChatInputWidget, {
			dispose: () => { }, saveState: () => { }, selectedModelState,
			sessionTypePicker: { onDidSelectSessionType: Event.None } as NewChatInputWidget['sessionTypePicker'],
		});
		instantiation.stub(IContextKeyService, new MockContextKeyService());
		instantiation.stub(IContextMenuService, {});
		instantiation.stub(IConfigurationService, { onDidChangeConfiguration: Event.None });
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ISessionsManagementService, {});
		instantiation.stub(ISessionsService, { activeSession: observableValue<IActiveSession | undefined>('activeSession', undefined) });
		instantiation.stub(IAquariumService, {});
		instantiation.stub(IAgentHostFilterService, {});
		instantiation.stub(IUriIdentityService, {});
		instantiation.stub(IAgentFeedbackService, { onDidChangeFeedback: Event.None, getFeedback: () => [] });
		instantiation.stub(IChatPetService, {});
		instantiation.stub(IChatTipService, {});
		instantiation.stub(IOpenerService, { registerOpener: () => toDisposable(() => { }) });
		const widget = disposables.add(instantiation.createInstance(NewChatWidget, {
			renderSessionTypePickerInControls: constObservable(false),
		} as IChatViewOptions));
		const renderedModels: (string | undefined)[] = [];
		Reflect.set(widget, '_renderChatTip', () => renderedModels.push(selectedModelState.get().currentModel?.identifier));
		return { widget, selectedModelState, renderedModels };
	}

	test('refreshes tips when the first model arrives and when models return after clearing', () => {
		const { selectedModelState, renderedModels } = createWidget();
		selectedModelState.set(modelState('first'), undefined);
		selectedModelState.set(modelState(undefined), undefined);
		selectedModelState.set(modelState('returned'), undefined);
		assert.deepStrictEqual(renderedModels, ['first', undefined, 'returned']);
	});

	test('refreshes an existing model change and ignores the same identifier', () => {
		const { selectedModelState, renderedModels } = createWidget('initial');
		selectedModelState.set(modelState('initial'), undefined);
		selectedModelState.set(modelState('changed'), undefined);
		selectedModelState.set(modelState('changed'), undefined);
		assert.deepStrictEqual(renderedModels, ['changed']);
	});

	test('stops model-driven tip refresh after disposal', () => {
		const { widget, selectedModelState, renderedModels } = createWidget('initial');
		widget.dispose();
		selectedModelState.set(modelState('after-dispose'), undefined);
		assert.deepStrictEqual(renderedModels, []);
	});
});
