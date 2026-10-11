/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IChatPetService } from '../../../../../workbench/contrib/chat/browser/chatPetService.js';
import { IChatTipService } from '../../../../../workbench/contrib/chat/browser/chatTipService.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatWidgetHistoryService } from '../../../../../workbench/contrib/chat/common/widget/chatWidgetHistoryService.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { IChatViewOptions } from '../../../../browser/parts/chatView.js';
import { IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { IActiveSession, IBackgroundSendFailedEvent, ISendRequestOptions, ISendRequestSentEvent, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISession } from '../../../../services/sessions/common/session.js';
import { IOpenNewSessionResult, ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { SessionsManagementService } from '../../../../services/sessions/browser/sessionsManagementService.js';
import { AGENT_FEEDBACK_NEW_SESSION_RESOURCE, AgentFeedbackKind, AgentFeedbackState, IAgentFeedback, IAgentFeedbackService } from '../../../agentFeedback/browser/agentFeedbackService.js';
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

	function createWidget(initialModel: string | undefined = undefined, configureServices?: (services: TestInstantiationService) => void) {
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
		instantiation.stub(ISessionsManagementService, { onDidSendRequest: Event.None, onDidFailBackgroundSend: Event.None });
		instantiation.stub(ISessionsService, { activeSession: observableValue<IActiveSession | undefined>('activeSession', undefined) });
		instantiation.stub(IAquariumService, {});
		instantiation.stub(IAgentHostFilterService, {});
		instantiation.stub(IUriIdentityService, {});
		instantiation.stub(IAgentFeedbackService, { onDidChangeFeedback: Event.None, getFeedback: () => [] });
		instantiation.stub(IChatPetService, {});
		instantiation.stub(IChatTipService, {});
		instantiation.stub(IOpenerService, { registerOpener: () => toDisposable(() => { }) });
		configureServices?.(instantiation);
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

	function createBackgroundWidget() {
		const session = new class extends mock<IActiveSession>() {
			override readonly sessionId = 'test:draft';
			override readonly providerId = 'test';
			override readonly sessionType = 'test';
			override readonly resource = URI.parse('test:/draft');
			override readonly isCreated = constObservable(false);
			override readonly workspace = constObservable(undefined);
			override readonly loading = constObservable(false);
			override readonly isQuickChat = constObservable(false);
		};
		const chat = new class extends mock<IChat>() {
			override readonly resource = URI.parse('test:/chat');
		};
		const feedbackItem: IAgentFeedback = {
			id: 'feedback', text: 'Keep this feedback after failure',
			resourceUri: URI.file('/project/file.ts'),
			range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
			sessionResource: AGENT_FEEDBACK_NEW_SESSION_RESOURCE,
			kind: AgentFeedbackKind.UserReview, state: AgentFeedbackState.Accepted,
		};
		const feedback = [feedbackItem];
		const removedFeedback: string[] = [];
		const creations: DeferredPromise<IChat>[] = [];
		const sends: DeferredPromise<ISession>[] = [];
		const sendStarted = new DeferredPromise<void>();
		const deletedDrafts: string[] = [];
		const failureWaits = disposables.add(new DisposableStore());
		const provider = new class extends mock<ISessionsProvider>() {
			override readonly id = session.providerId;
			override readonly sessionTypes = [];
			override readonly onDidChangeSessions = Event.None;
			override readonly onDidChangeSessionTypes = Event.None;
			override createNewChat(): Promise<IChat> {
				const creation = new DeferredPromise<IChat>();
				creations.push(creation);
				return creation.p;
			}
			override sendRequest(): Promise<ISession> {
				const send = new DeferredPromise<ISession>();
				sends.push(send);
				sendStarted.complete();
				return send.p;
			}
			override deleteNewSession(sessionId: string): void {
				deletedDrafts.push(sessionId);
			}
		};
		const providers = new class extends mock<ISessionsProvidersService>() {
			override readonly onDidChangeProviders = Event.None;
			override getProviders(): ISessionsProvider[] { return [provider]; }
			override getProvider<T extends ISessionsProvider>(providerId: string): T | undefined {
				return (providerId === provider.id ? provider : undefined) as T | undefined;
			}
		};
		const { widget } = createWidget(undefined, services => {
			services.stub(ISessionsProvidersService, providers);
			services.stub(IChatService, { onDidSubmitRequest: Event.None });
			services.stub(IChatWidgetHistoryService, {});
			services.stub(IStorageService, disposables.add(new InMemoryStorageService()));
			services.stub(IPathService, {});
			services.stub(IRemoteAgentHostService, {});
			services.stub(IWorkspaceTrustManagementService, {});
			services.stub(ISessionsManagementService, disposables.add(services.createInstance(SessionsManagementService)));
			services.stub(ISessionsService, { activeSession: constObservable(session) });
			services.stub(IAgentFeedbackService, {
				onDidChangeFeedback: Event.None, getFeedback: () => feedback,
				removeFeedback: (_resource, id) => {
					removedFeedback.push(id);
					const index = feedback.findIndex(item => item.id === id);
					if (index >= 0) { feedback.splice(index, 1); }
				},
			});
		});
		const service = Reflect.get(widget, 'sessionsManagementService') as SessionsManagementService;
		assert.strictEqual(typeof service.onDidSendRequest, 'function');
		assert.strictEqual(typeof service.onDidFailBackgroundSend, 'function');
		const pending = Reflect.get(widget, '_pendingBackgroundSends') as DisposableMap<ISendRequestOptions, DisposableStore>;
		const sentEmitter = Reflect.get(service, '_onDidSendRequest') as Emitter<ISendRequestSentEvent>;
		const failedEmitter = Reflect.get(service, '_onDidFailBackgroundSend') as Emitter<IBackgroundSendFailedEvent>;
		const send = Reflect.get(widget, '_send') as (query: string, context: undefined, background: boolean) => Promise<boolean>;
		return {
			widget, service, session, chat, pending, creations, sends, sendStarted, deletedDrafts,
			send: (query: string) => send.call(widget, query, undefined, true),
			waitForFailure: (options: ISendRequestOptions) => Event.toPromise(Event.filter(service.onDidFailBackgroundSend, event => event.options === options), failureWaits),
			assertState: (pendingCount: number) => {
				assert.strictEqual(pending.size, pendingCount);
				assert.strictEqual(sentEmitter.hasListeners(), pendingCount > 0);
				assert.strictEqual(failedEmitter.hasListeners(), pendingCount > 0);
				assert.deepStrictEqual(removedFeedback, []);
				assert.deepStrictEqual(feedback, [feedbackItem]);
			},
		};
	}

	test('releases background listeners and retains feedback when createNewChat rejects', async () => {
		const fixture = createBackgroundWidget();
		assert.strictEqual(await fixture.send('create failure'), true);
		fixture.assertState(1);
		assert.strictEqual(fixture.creations.length, 1);
		const [options] = [...fixture.pending.keys()];
		const subscriptions = fixture.pending.get(options)!;
		const failed = fixture.waitForFailure(options);
		fixture.creations[0].error(new Error('createNewChat rejected'));
		const event = await failed;
		assert.strictEqual(event.session, fixture.session);
		assert.strictEqual(event.options, options);
		assert.strictEqual(subscriptions.isDisposed, true);
		assert.strictEqual(fixture.sends.length, 0);
		assert.deepStrictEqual(fixture.deletedDrafts, [fixture.session.sessionId]);
		fixture.assertState(0);
	});

	test('releases background listeners and retains feedback when sendRequest rejects', async () => {
		const fixture = createBackgroundWidget();
		assert.strictEqual(await fixture.send('send failure'), true);
		fixture.assertState(1);
		const [options] = [...fixture.pending.keys()];
		const subscriptions = fixture.pending.get(options)!;
		fixture.creations[0].complete(fixture.chat);
		await fixture.sendStarted.p;
		assert.strictEqual(fixture.sends.length, 1);
		const failed = fixture.waitForFailure(options);
		fixture.sends[0].error(new Error('sendRequest rejected'));
		await failed;
		assert.strictEqual(subscriptions.isDisposed, true);
		assert.deepStrictEqual(fixture.deletedDrafts, [fixture.session.sessionId]);
		fixture.assertState(0);
	});

	test('ignores foreign background options and releases only the matching pending send', async () => {
		const fixture = createBackgroundWidget();
		assert.strictEqual(await fixture.send('first'), true);
		assert.strictEqual(await fixture.send('second'), true);
		fixture.assertState(2);
		const [first, second] = [...fixture.pending.keys()];
		const firstSubscriptions = fixture.pending.get(first)!;
		const secondSubscriptions = fixture.pending.get(second)!;
		const foreign = { ...first };
		assert.notStrictEqual(foreign, first);
		const foreignFailed = fixture.waitForFailure(foreign);
		await fixture.service.sendNewChatRequest(fixture.session, foreign);
		assert.strictEqual(fixture.creations.length, 3);
		fixture.creations[2].error(new Error('foreign createNewChat rejected'));
		await foreignFailed;
		assert.deepStrictEqual([...fixture.pending.keys()], [first, second]);
		assert.strictEqual(firstSubscriptions.isDisposed, false);
		assert.strictEqual(secondSubscriptions.isDisposed, false);
		fixture.assertState(2);
		const firstFailed = fixture.waitForFailure(first);
		fixture.creations[0].error(new Error('first createNewChat rejected'));
		await firstFailed;
		assert.strictEqual(fixture.pending.has(first), false);
		assert.strictEqual(fixture.pending.has(second), true);
		assert.strictEqual(firstSubscriptions.isDisposed, true);
		assert.strictEqual(secondSubscriptions.isDisposed, false);
		fixture.assertState(1);
		const secondFailed = fixture.waitForFailure(second);
		fixture.creations[1].error(new Error('second createNewChat rejected'));
		await secondFailed;
		assert.strictEqual(secondSubscriptions.isDisposed, true);
		fixture.assertState(0);
	});

	test('does not touch widget pending sends or feedback when background failure arrives after disposal', async () => {
		const fixture = createBackgroundWidget();
		assert.strictEqual(await fixture.send('late failure'), true);
		fixture.assertState(1);
		const [options] = [...fixture.pending.keys()];
		const subscriptions = fixture.pending.get(options)!;
		fixture.widget.dispose();
		assert.strictEqual(subscriptions.isDisposed, true);
		fixture.assertState(0);
		let lateDeletes = 0;
		const deleteAndDispose = fixture.pending.deleteAndDispose.bind(fixture.pending);
		fixture.pending.deleteAndDispose = key => { lateDeletes++; deleteAndDispose(key); };
		const failed = fixture.waitForFailure(options);
		fixture.creations[0].error(new Error('late createNewChat rejected'));
		await failed;
		assert.strictEqual(lateDeletes, 0);
		fixture.assertState(0);
	});
});
