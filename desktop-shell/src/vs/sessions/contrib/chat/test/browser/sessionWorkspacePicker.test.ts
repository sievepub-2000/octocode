/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind } from '../../../../../platform/actionWidget/browser/actionList.js';
import { RemoteAgentHostConnectionStatus, IRemoteAgentHostService, RemoteAgentHostsEnabledSettingId } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { IOutputService } from '../../../../../workbench/services/output/common/output.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { extUri } from '../../../../../base/common/resources.js';
import { ISessionsProvidersChangeEvent, ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISendRequestOptions, ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { IAgentHostSessionsProvider } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionWorkspace, ISessionWorkspaceBrowseAction, SESSION_WORKSPACE_GROUP_LOCAL, SESSION_WORKSPACE_GROUP_REMOTE } from '../../../../services/sessions/common/session.js';
import { IWorkspacePickerItem, IWorkspacePickerOptions, WorkspacePicker } from '../../browser/sessionWorkspacePicker.js';
import { ISessionsRecentWorkspacesService, SessionsRecentWorkspacesService } from '../../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { AutomationsWorkspacePicker } from '../../../automations/browser/automationDialog.js';
import { AutomationIsolationModel } from '../../../automations/common/isolationGroupModel.js';
import { buildMobileWorkspacePickerRows, showMobileWorkspacePickerSheet } from '../../browser/mobile/mobileWorkspacePickerSheet.js';
import { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService, MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { INotification, INotificationHandle, INotificationService, NoOpNotification, NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { NullOpenerService } from '../../../../../platform/opener/test/common/nullOpenerService.js';

// ---- Storage key (must match the one in sessionWorkspacePicker.ts) ----------
const STORAGE_KEY_RECENT_WORKSPACES = 'sessions.recentlyPickedWorkspaces';

// ---- Mock providers ---------------------------------------------------------

// Maps mock provider id → URI path prefix it resolves. In production, the
// URI's authority/scheme determines which provider can resolve it; the
// tests use file URIs only, so we map provider ids to their conventional
// path roots (e.g. /remote, /local, /copilot, /agent-host).
const MOCK_PROVIDER_PATH_PREFIXES: Record<string, string> = {
	'agenthost-remote-1': '/remote',
	'local-1': '/local',
	'default-copilot': '/copilot',
	'local-agent-host': '/agent-host',
};

function createMockProvider(id: string, opts?: {
	connectionStatus?: ISettableObservable<RemoteAgentHostConnectionStatus>;
	browseActions?: readonly ISessionWorkspaceBrowseAction[];
	canConnectOnDemand?: boolean;
	connect?: () => Promise<void>;
	onDidReportConnectProgress?: Event<{ readonly connectionKey: string; readonly message: string }>;
	remoteAddress?: string;
}): ISessionsProvider {
	const pathPrefix = MOCK_PROVIDER_PATH_PREFIXES[id];
	const canResolve = (uri: URI) => !pathPrefix || uri.path === pathPrefix || uri.path.startsWith(`${pathPrefix}/`);
	const base = {
		id,
		label: `Provider ${id}`,
		icon: Codicon.remote,
		order: 0,
		sessionTypes: [],
		onDidChangeSessionTypes: Event.None,
		browseActions: opts?.browseActions ?? [],
		resolveWorkspace: (uri: URI): ISessionWorkspace | undefined => {
			if (!canResolve(uri)) {
				return undefined;
			}
			return {
				uri,
				label: uri.path.substring(1) || uri.path,
				icon: Codicon.folder,
				folders: [{
					root: uri,
					workingDirectory: uri,
					name: uri.path.substring(1) || uri.path,
					description: undefined,
					gitRepository: { uri, workTreeUri: undefined, baseBranchName: undefined, gitHubInfo: constObservable(undefined) },
				}],
				requiresWorkspaceTrust: false,
				isVirtualWorkspace: false,
			};
		},
		onDidChangeSessions: Event.None,
		getSessions: () => [],
		createNewSession: () => { throw new Error('Not implemented'); },
		createQuickChat: () => { throw new Error('Not implemented'); },
		deleteNewSession: () => { },
		getSessionTypes: () => [],
		renameChat: async () => { },
		renameSession: async () => { },
		getModelsSnapshot: () => ({ models: [], desiredModelResolution: { kind: 'notRequested' as const }, modelTarget: undefined }),
		getModelPickerOptions: () => ({ useGroupedModelPicker: true, showFeatured: true, showUnavailableFeatured: false, showManageModelsAction: false }),
		onDidChangeModels: Event.None,
		setModel: () => { },
		archiveSession: async () => { },
		unarchiveSession: async () => { },
		setSessionReadState: async () => { },
		deleteSession: async () => { },
		deleteSessions: async () => { },
		deleteChat: async () => true,
		createNewChat: async () => { throw new Error('Not implemented'); },
		forkChat: async () => { throw new Error('Not implemented'); },
		createSideChat: async () => { throw new Error('Not implemented'); },
		sendRequest: async (_sessionId: string, _chatResource: URI, _options: ISendRequestOptions) => { throw new Error('Not implemented'); },
	};
	if (opts?.connectionStatus) {
		return {
			...base,
			canConnectOnDemand: opts.canConnectOnDemand,
			connect: opts.connect,
			connectionStatus: opts.connectionStatus,
			onDidReportConnectProgress: opts.onDidReportConnectProgress,
			remoteAddress: opts.remoteAddress,
			onDidChangeSessionConfig: Event.None,
			getSessionConfig: () => undefined,
			setSessionConfigValue: async () => { },
			replaceSessionConfig: async () => { },
			getSessionConfigCompletions: async () => [],
			getCreateSessionConfig: () => undefined,
			clearSessionConfig: () => { },
			onDidChangeRootConfig: Event.None,
			getRootConfig: () => undefined,
			setRootConfigValue: async () => { },
			replaceRootConfig: async () => { },
		} as unknown as IAgentHostSessionsProvider;
	}
	return base;
}

class MockSessionsProvidersService extends Disposable {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProviders = this._register(new Emitter<ISessionsProvidersChangeEvent>());
	readonly onDidChangeProviders: Event<ISessionsProvidersChangeEvent> = this._onDidChangeProviders.event;

	private _providers: ISessionsProvider[] = [];

	setProviders(providers: ISessionsProvider[]): void {
		const oldProviders = this._providers;
		this._providers = providers;
		const oldIds = new Set(oldProviders.map(p => p.id));
		const newIds = new Set(providers.map(p => p.id));
		this._onDidChangeProviders.fire({
			added: providers.filter(p => !oldIds.has(p.id)),
			removed: oldProviders.filter(p => !newIds.has(p.id)),
		});
	}

	getProviders(): ISessionsProvider[] {
		return this._providers;
	}

	getProvider<T extends ISessionsProvider>(providerId: string): T | undefined {
		return this._providers.find(p => p.id === providerId) as T | undefined;
	}

	resolveWorkspace(folderUri: URI, preferredProviderId?: string) {
		if (preferredProviderId) {
			const preferred = this.getProvider(preferredProviderId);
			const workspace = preferred?.resolveWorkspace(folderUri);
			if (workspace) {
				return { providerId: preferredProviderId, workspace };
			}
		}
		for (const provider of this.getProviders()) {
			const workspace = provider.resolveWorkspace(folderUri);
			if (workspace) {
				return { providerId: provider.id, workspace };
			}
		}
		return undefined;
	}
}

class RecordingNotificationHandle extends NoOpNotification {
	closed = false;
	messages: NotificationMessage[] = [];

	constructor(message: NotificationMessage) {
		super();
		this.messages.push(message);
	}

	override updateMessage(message: NotificationMessage): void {
		this.messages.push(message);
	}

	override close(): void {
		this.closed = true;
	}
}

class RecordingNotificationService extends TestNotificationService {
	readonly handles: RecordingNotificationHandle[] = [];
	readonly errors: Array<string | Error> = [];

	override notify(notification: INotification): INotificationHandle {
		const handle = new RecordingNotificationHandle(notification.message);
		this.handles.push(handle);
		return handle;
	}

	override error(error: string | Error): INotificationHandle {
		this.errors.push(error);
		return super.error(error);
	}
}

class DispatchingWorkspacePicker extends WorkspacePicker {
	dispatchFolder(folderUri: URI, providerId: string): Promise<boolean> {
		return this._dispatchPickerItem({ folderUri, providerId });
	}

	getItems() {
		return this._buildItems();
	}

	dispatchItem(item: IWorkspacePickerItem): Promise<boolean> {
		return this._dispatchPickerItem(item);
	}

	removeRecent(folderUri: URI): void {
		this._removeRecentWorkspace(folderUri);
	}
}

class TestAutomationsWorkspacePicker extends AutomationsWorkspacePicker {
	getItems() {
		return this._buildItems();
	}

	getItemStates(): Array<{ readonly label: string; readonly checked: boolean }> {
		return this.getItems()
			.filter(entry => entry.item)
			.map(entry => ({ label: entry.label ?? '', checked: entry.item?.checked === true }));
	}

	async select(label: string): Promise<void> {
		const entry = this.getItems().find(candidate => candidate.label === label);
		assert.ok(entry?.item, `Expected picker item '${label}'`);
		await this._dispatchPickerItem(entry.item);
	}
}

class FlatBrowserWorkspacePicker extends WorkspacePicker {
	protected override _showTabs(): boolean {
		return false;
	}
}

/** Uses the platform tabbed-widget test's context-view lifecycle with real list DOM. */
class WorkspacePickerBrowserContextView extends Disposable implements Partial<IContextViewService> {
	declare readonly _serviceBrand: undefined;
	private _container: HTMLElement | undefined;
	private _delegate: IContextViewDelegate | undefined;
	private _renderDisposable: IDisposable | undefined;

	constructor(private readonly host: HTMLElement) {
		super();
	}

	showContextView(delegate: IContextViewDelegate): { close: () => void } {
		this.hideContextView();
		this._delegate = delegate;
		const container = document.createElement('div');
		container.className = 'context-view';
		this._container = container;
		this.host.appendChild(container);
		const renderDisposable = delegate.render(container);
		if (this._delegate === delegate) {
			this._renderDisposable = renderDisposable;
		} else {
			renderDisposable.dispose();
		}
		return { close: () => this.hideContextView() };
	}

	hideContextView(): void {
		const delegate = this._delegate;
		const renderDisposable = this._renderDisposable;
		const container = this._container;
		this._delegate = undefined;
		this._renderDisposable = undefined;
		this._container = undefined;
		delegate?.onHide?.();
		renderDisposable?.dispose();
		container?.remove();
	}

	getContextViewElement(): HTMLElement {
		return this._container ?? this.host;
	}

	layout(): void { }

	override dispose(): void {
		this.hideContextView();
		super.dispose();
	}
}

// ---- Test helpers -----------------------------------------------------------

function seedStorage(storageService: IStorageService, entries: { uri: URI; providerId: string; checked: boolean }[]): void {
	const stored = entries.map(e => ({
		uri: e.uri.toJSON(),
		providerId: e.providerId,
		checked: e.checked,
	}));
	storageService.store(STORAGE_KEY_RECENT_WORKSPACES, JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.MACHINE);
}

function createTestPicker(
	disposables: DisposableStore,
	providersService: MockSessionsProvidersService,
	storageService?: IStorageService,
	notificationService: INotificationService = new TestNotificationService(),
	pickerCtor: typeof WorkspacePicker = WorkspacePicker,
	fileDialogService: Partial<IFileDialogService> = {},
	workspacesService: IWorkspacesService = { getRecentlyOpened: async () => ({ workspaces: [], files: [] }), onDidChangeRecentlyOpened: Event.None } as unknown as IWorkspacesService,
	recentWorkspacesService?: ISessionsRecentWorkspacesService,
	options?: IWorkspacePickerOptions,
	commandService?: Partial<ICommandService>,
	configureServices?: (instantiationService: TestInstantiationService) => void,
): WorkspacePicker {
	const instantiationService = disposables.add(new TestInstantiationService());
	const storage = storageService ?? disposables.add(new TestStorageService());

	instantiationService.stub(IActionWidgetService, { isVisible: false, hide: () => { }, show: () => { } });
	instantiationService.stub(IContextViewService, { showContextView: () => ({ close: () => { } }), hideContextView: () => { }, layout: () => { } });
	instantiationService.stub(IStorageService, storage);
	instantiationService.stub(IUriIdentityService, { extUri });
	instantiationService.stub(ISessionsProvidersService, providersService);
	instantiationService.stub(IRemoteAgentHostService, {});
	instantiationService.stub(IQuickInputService, {});
	instantiationService.stub(IClipboardService, {});
	instantiationService.stub(IPreferencesService, {});
	instantiationService.stub(IOutputService, {});
	instantiationService.stub(IConfigurationService, new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true }));
	instantiationService.stub(ICommandService, commandService ?? { executeCommand: async () => { } });
	instantiationService.stub(IFileDialogService, fileDialogService);
	instantiationService.stub(IContextKeyService, new MockContextKeyService());
	instantiationService.stub(IMenuService, {
		createMenu: () => ({ onDidChange: Event.None, getActions: () => [], dispose: () => { } }),
		getMenuActions: () => [],
	});
	instantiationService.stub(INotificationService, notificationService);
	instantiationService.stub(IWorkspacesService, workspacesService);
	instantiationService.stub(ISessionsRecentWorkspacesService, recentWorkspacesService ?? disposables.add(instantiationService.createInstance(SessionsRecentWorkspacesService)));
	instantiationService.stub(ITelemetryService, NullTelemetryService);

	configureServices?.(instantiationService);

	return disposables.add(instantiationService.createInstance(pickerCtor, options ?? {}));
}

/**
 * Builds a {@link SessionsRecentWorkspacesService} and waits for its initial
 * (asynchronous) VS Code recents fetch to complete, so a picker constructed
 * against it afterwards restores against a fully-populated recents list
 * instead of racing the fetch (as happens when {@link createTestPicker}
 * builds its own service inline).
 */
async function createResolvedRecentWorkspacesService(
	disposables: DisposableStore,
	storageService: IStorageService,
	providersService: MockSessionsProvidersService,
	workspacesService: IWorkspacesService,
): Promise<ISessionsRecentWorkspacesService> {
	const instantiationService = disposables.add(new TestInstantiationService());
	instantiationService.stub(IStorageService, storageService);
	instantiationService.stub(IUriIdentityService, { extUri });
	instantiationService.stub(IWorkspacesService, workspacesService);
	instantiationService.stub(ISessionsProvidersService, providersService);
	const recentWorkspacesService = disposables.add(instantiationService.createInstance(SessionsRecentWorkspacesService));
	await new Promise<void>(resolve => {
		const listener = recentWorkspacesService.onDidChangeRecentWorkspaces(() => {
			listener.dispose();
			resolve();
		});
	});
	return recentWorkspacesService;
}

// ---- Assertion helpers ------------------------------------------------------

function assertSelectedProvider(picker: WorkspacePicker, expectedProviderId: string | undefined, message?: string): void {
	assert.strictEqual(picker.selectedResolved?.providerId, expectedProviderId, message);
}

// ---- Tests ------------------------------------------------------------------

suite('WorkspacePicker - Connection Status', () => {

	const disposables = new DisposableStore();
	let providersService: MockSessionsProvidersService;

	setup(() => {
		providersService = new MockSessionsProvidersService();
		disposables.add(providersService);
	});

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('restore picks checked entry even when remote is disconnected (before grace period)', () => {
		// Restore is honored synchronously: the picker shows the checked entry
		// while we wait to see if the connection comes up. The grace-period
		// fallback (covered in a separate test) only fires later.
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: false },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1');
	});

	test('restore ignores VS Code\'s global recents, using only the sessions\' own history', async () => {
		const localProvider = createMockProvider('local-1');
		providersService.setProviders([localProvider]);

		const ownUri = URI.file('/local/own-project');
		const globalUri = URI.file('/local/global-only-project');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: ownUri, providerId: 'local-1', checked: false }]);

		const workspacesService = { getRecentlyOpened: async () => ({ workspaces: [{ folderUri: globalUri }], files: [] }), onDidChangeRecentlyOpened: Event.None } as unknown as IWorkspacesService;
		const recentWorkspacesService = await createResolvedRecentWorkspacesService(disposables, storage, providersService, workspacesService);

		// Sanity: the merged (display) list includes both entries...
		assert.deepStrictEqual(
			recentWorkspacesService.getRecentWorkspaces().map(r => r.workspace.uri.toString()),
			[ownUri.toString(), globalUri.toString()],
		);
		// ...but the own-only query used for restoration excludes the global one.
		assert.deepStrictEqual(
			recentWorkspacesService.getRecentWorkspaces(false).map(r => r.workspace.uri.toString()),
			[ownUri.toString()],
		);

		const picker = createTestPicker(disposables, providersService, storage, undefined, undefined, undefined, workspacesService, recentWorkspacesService);

		assert.strictEqual(picker.selectedFolderUri?.toString(), ownUri.toString(), 'restore selects only the sessions-owned entry, not the VS Code global recent');
	});

	test('restore selects nothing when own history is empty, even with VS Code global recents present', async () => {
		const localProvider = createMockProvider('local-1');
		providersService.setProviders([localProvider]);

		const globalUri = URI.file('/local/global-only-project');
		const storage = disposables.add(new TestStorageService());

		const workspacesService = { getRecentlyOpened: async () => ({ workspaces: [{ folderUri: globalUri }], files: [] }), onDidChangeRecentlyOpened: Event.None } as unknown as IWorkspacesService;
		const recentWorkspacesService = await createResolvedRecentWorkspacesService(disposables, storage, providersService, workspacesService);

		const picker = createTestPicker(disposables, providersService, storage, undefined, undefined, undefined, workspacesService, recentWorkspacesService);

		assert.strictEqual(picker.selectedFolderUri, undefined, 'restore selects nothing when there is no owned history to restore from');
	});

	test('filters worktree checkout folders from VS Code global recents only', async () => {
		const provider = createMockProvider('provider');
		providersService.setProviders([provider]);

		const ownWorktreeUri = URI.file('/code/owned.worktrees/feature');
		const globalWorktreeUri = URI.file('/code/vscode.worktrees/feature');
		const globalUppercaseWorktreeUri = URI.file('/code/VSCode.WORKTREES/other-feature');
		const globalSimilarUri = URI.file('/code/vscode.worktrees-backup/feature');
		const globalRegularUri = URI.file('/code/vscode/feature');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: ownWorktreeUri, providerId: 'provider', checked: false }]);

		const workspacesService = {
			getRecentlyOpened: async () => ({
				workspaces: [
					{ folderUri: globalWorktreeUri },
					{ folderUri: globalUppercaseWorktreeUri },
					{ folderUri: globalSimilarUri },
					{ folderUri: globalRegularUri },
				],
				files: [],
			}),
			onDidChangeRecentlyOpened: Event.None,
		} as unknown as IWorkspacesService;
		const recentWorkspacesService = await createResolvedRecentWorkspacesService(disposables, storage, providersService, workspacesService);

		assert.deepStrictEqual(
			recentWorkspacesService.getRecentWorkspaces().map(recent => recent.workspace.uri.toString()),
			[ownWorktreeUri, globalSimilarUri, globalRegularUri].map(uri => uri.toString()),
		);
	});

	test('restored remote that never connects falls back after grace period', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		// The provider is registered as Disconnected and never transitions —
		// e.g. SSH host is unreachable and the status was set before the picker
		// could subscribe. The picker should fall back to no selection after
		// the grace period so the view pane drops the stale session.
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection is restored synchronously');

		const events: Array<URI | undefined> = [];
		disposables.add(picker.onDidSelectWorkspace(e => events.push(e)));

		// Advance past the grace period.
		await timeout(10_000);

		assertSelectedProvider(picker, undefined, 'Selection cleared after grace period');
		assert.deepStrictEqual(events, [undefined], 'onDidSelectWorkspace fired with undefined');
	}));

	test('restored remote that connects within grace period keeps selection', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// Connection succeeds quickly.
		await timeout(100);
		remoteStatus.set(RemoteAgentHostConnectionStatus.connecting, undefined);
		await timeout(500);
		remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined);

		// Advance past the grace period — should not fall back since we connected.
		await timeout(10_000);

		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection preserved after successful connect');
	}));

	test('user pick during connect cancels the fallback', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		// If the user picks a different workspace while the restore-grace-period
		// timer is running, the timer must not later clear the user's selection.
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// User picks a local workspace while the remote is still trying to connect.
		picker.setSelectedWorkspace(URI.file('/local/picked'), { fireEvent: false });

		// Grace period elapses; remote still disconnected — must not affect user pick.
		await timeout(10_000);

		assertSelectedProvider(picker, 'local-1', 'User pick preserved across grace-period elapse');
	}));

	test('restore picks checked entry while remote is connecting (no fallback flicker)', () => {
		// SSH remote: provider registers in Disconnected state and immediately
		// starts connecting. We restore the checked entry immediately rather than
		// falling back to a different workspace and swapping later.
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: false },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1');

		// Connection attempt starts (no fallback while connecting).
		remoteStatus.set(RemoteAgentHostConnectionStatus.connecting, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1');

		// After connection completes, selection is unchanged.
		remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1');
	});

	test('connecting provider that fails falls back to no selection', () => {
		// Real SSH remote lifecycle: starts Disconnected, transitions Connecting,
		// then fails back to Disconnected. The picker must clear the selection
		// and fire onDidSelectWorkspace(undefined) so the view pane calls unsetNewSession().
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection is restored while connecting');

		const events: Array<URI | undefined> = [];
		disposables.add(picker.onDidSelectWorkspace(e => events.push(e)));

		// SSH tunnel begins.
		remoteStatus.set(RemoteAgentHostConnectionStatus.connecting, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection preserved while connecting');

		// SSH tunnel fails.
		remoteStatus.set(RemoteAgentHostConnectionStatus.disconnected, undefined);

		assertSelectedProvider(picker, undefined, 'Selection cleared after connection failure');
		assert.deepStrictEqual(events, [undefined], 'onDidSelectWorkspace fired with undefined');
	});

	test('restore picks connected remote provider', () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1');
	});

	test('disconnect preserves selection (renders grayed; no auto-clear)', () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);
		assertSelectedProvider(picker, 'agenthost-remote-1');

		// Disconnect — selection is preserved (the user picked it; we keep honoring it).
		remoteStatus.set(RemoteAgentHostConnectionStatus.disconnected, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection should be preserved on disconnect');
	});

	test('failed on-demand recent connect closes progress notification and reports error', async () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.disconnected);
		const progress = new Emitter<{ readonly connectionKey: string; readonly message: string }>();
		disposables.add(progress);
		let connectCalls = 0;
		const remoteProvider = createMockProvider('agenthost-remote-1', {
			connectionStatus: remoteStatus,
			canConnectOnDemand: true,
			remoteAddress: 'wsl:Ubuntu-24.04',
			onDidReportConnectProgress: progress.event,
			connect: async () => {
				connectCalls++;
				progress.fire({ connectionKey: 'wsl:Ubuntu-24.04', message: 'Opening WSL...' });
				throw new Error('boom');
			},
		});
		const notifications = new RecordingNotificationService();

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, undefined, notifications, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;

		await picker.dispatchFolder(URI.file('/remote/project'), 'agenthost-remote-1');

		assert.deepStrictEqual({
			connectCalls,
			progressClosed: notifications.handles[0]?.closed,
			progressMessages: notifications.handles[0]?.messages,
			errors: notifications.errors.map(error => String(error)),
			selectedProvider: picker.selectedResolved?.providerId,
		}, {
			connectCalls: 1,
			progressClosed: true,
			progressMessages: ['Connecting to Provider agenthost-remote-1...', 'Opening WSL...'],
			errors: ['Failed to connect to Provider agenthost-remote-1.'],
			selectedProvider: undefined,
		});
	});

	test('reconnect keeps the selection (no extra event fires)', () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);
		assertSelectedProvider(picker, 'agenthost-remote-1');

		// Disconnect / reconnect cycle — selection preserved throughout.
		remoteStatus.set(RemoteAgentHostConnectionStatus.disconnected, undefined);
		remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1');
		assert.strictEqual(
			picker.selectedResolved?.workspace.folders[0]?.root.path,
			'/remote/project',
		);
	});

	test('checked is globally unique after persist', () => {
		const localProvider = createMockProvider('local-1');
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: false },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// Select the local workspace
		const resolvedWorkspace = localProvider.resolveWorkspace(URI.file('/local/project'));
		assert.ok(resolvedWorkspace, 'resolveWorkspace should resolve file:// URIs');
		picker.setSelectedWorkspace(URI.file('/local/project'), { fireEvent: false });

		// Verify storage: only the local entry should be checked
		const raw = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
		assert.ok(raw, 'Storage should have recent workspaces');
		const stored = JSON.parse(raw!) as { uri: { path: string }; checked: boolean }[];
		const checkedEntries = stored.filter(e => e.checked);
		assert.strictEqual(checkedEntries.length, 1, 'Only one entry should be checked');
		assert.strictEqual(checkedEntries[0].uri.path, '/local/project', 'The local entry should be checked');
	});

	test('removing the selected workspace cancels an in-flight remote selection', async () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('remoteStatus', RemoteAgentHostConnectionStatus.disconnected);
		const connectStarted = new DeferredPromise<void>();
		const finishConnect = new DeferredPromise<void>();
		const remoteProvider = createMockProvider('agenthost-remote-1', {
			connectionStatus: remoteStatus,
			canConnectOnDemand: true,
			connect: async () => {
				await connectStarted.complete();
				await finishConnect.p;
				remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined);
			},
		});
		const folder = URI.file('/remote/project');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: folder, providerId: remoteProvider.id, checked: true }]);
		providersService.setProviders([remoteProvider]);
		const workspacesService = upcastPartial<IWorkspacesService>({
			getRecentlyOpened: async () => ({ workspaces: [], files: [] }),
			onDidChangeRecentlyOpened: Event.None,
			removeRecentlyOpened: async () => { },
		});
		const picker = createTestPicker(disposables, providersService, storage, undefined, DispatchingWorkspacePicker, undefined, workspacesService) as DispatchingWorkspacePicker;
		const selectedEvents: Array<string | undefined> = [];
		const changedSelections: Array<string | undefined> = [];
		disposables.add(picker.onDidSelectWorkspace(uri => selectedEvents.push(uri?.toString())));
		disposables.add(picker.onDidChangeSelection(() => changedSelections.push(picker.selectedFolderUri?.toString())));

		const staleSelection = picker.dispatchFolder(folder, remoteProvider.id);
		await connectStarted.p;
		picker.removeRecent(folder);
		await finishConnect.complete();
		const applied = await staleSelection;

		assert.deepStrictEqual({
			applied,
			selectedFolder: picker.selectedFolderUri,
			selectedEvents,
			changedSelections,
			storedRecents: JSON.parse(storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE)!),
		}, {
			applied: false,
			selectedFolder: undefined,
			selectedEvents: [undefined],
			changedSelections: [undefined],
			storedRecents: [],
		});
	});

	test('removing a pending workspace preserves the current workspace', async () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('remoteStatus', RemoteAgentHostConnectionStatus.disconnected);
		const connectStarted = new DeferredPromise<void>();
		const finishConnect = new DeferredPromise<void>();
		const remote = createMockProvider('agenthost-remote-1', {
			connectionStatus: remoteStatus,
			canConnectOnDemand: true,
			connect: async () => {
				await connectStarted.complete();
				await finishConnect.p;
				remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined);
			},
		});
		const local = createMockProvider('local-1');
		const currentFolder = URI.file('/local/current');
		const pendingFolder = URI.file('/remote/pending');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: currentFolder, providerId: local.id, checked: true },
			{ uri: pendingFolder, providerId: remote.id, checked: false },
		]);
		providersService.setProviders([local, remote]);
		const workspacesService = upcastPartial<IWorkspacesService>({
			getRecentlyOpened: async () => ({ workspaces: [], files: [] }),
			onDidChangeRecentlyOpened: Event.None,
			removeRecentlyOpened: async () => { },
		});
		const picker = createTestPicker(disposables, providersService, storage, undefined, DispatchingWorkspacePicker, undefined, workspacesService) as DispatchingWorkspacePicker;
		const selectedEvents: Array<string | undefined> = [];
		disposables.add(picker.onDidSelectWorkspace(uri => selectedEvents.push(uri?.toString())));
		const pending = picker.dispatchFolder(pendingFolder, remote.id);
		await connectStarted.p;
		picker.removeRecent(pendingFolder);
		await finishConnect.complete();
		const applied = await pending;

		assert.deepStrictEqual({ applied, selected: picker.selectedFolderUri?.toString(), selectedEvents }, {
			applied: false,
			selected: currentFolder.toString(),
			selectedEvents: [],
		});
	});

	test('reports an asynchronously rejected inline action', async () => {
		const notifications = new RecordingNotificationService();
		const finish = new DeferredPromise<void>();
		const failure = new Error('Inline action failed');
		const picker = createTestPicker(disposables, providersService, undefined, notifications, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const pending = picker.dispatchItem({
			run: async () => {
				await finish.p;
				throw failure;
			},
		});
		await finish.complete();

		assert.deepStrictEqual({ applied: await pending, errors: notifications.errors }, {
			applied: false,
			errors: [failure.message],
		});
	});

	test('reports an asynchronously rejected command', async () => {
		const notifications = new RecordingNotificationService();
		const finish = new DeferredPromise<void>();
		const failure = new Error('Command failed');
		const commands: string[] = [];
		const picker = createTestPicker(
			disposables,
			providersService,
			undefined,
			notifications,
			DispatchingWorkspacePicker,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				executeCommand: async id => {
					commands.push(id);
					await finish.p;
					throw failure;
				},
			},
		) as DispatchingWorkspacePicker;
		const pending = picker.dispatchItem({ commandId: 'test.workspacePicker.reject' });
		await finish.complete();

		assert.deepStrictEqual({ applied: await pending, errors: notifications.errors, commands }, {
			applied: false,
			errors: [failure.message],
			commands: ['test.workspacePicker.reject'],
		});
	});

	for (const choice of ['recent', 'browse'] as const) {
		test(`reports a rejected workspace admission for a ${choice} choice`, async () => {
			const currentFolder = URI.file('/local/current');
			const proposedFolder = URI.file('/local/proposed');
			const finish = new DeferredPromise<void>();
			const started = new DeferredPromise<void>();
			const failure = new Error('Workspace admission failed');
			const notifications = new RecordingNotificationService();
			const action: ISessionWorkspaceBrowseAction = {
				...makeBrowseAction('local-1', SESSION_WORKSPACE_GROUP_LOCAL),
				run: async () => provider.resolveWorkspace(proposedFolder),
			};
			const provider = createMockProvider('local-1', { browseActions: [action] });
			providersService.setProviders([provider]);
			const storage = disposables.add(new TestStorageService());
			seedStorage(storage, [{ uri: currentFolder, providerId: provider.id, checked: true }]);
			const before = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
			const picker = createTestPicker(disposables, providersService, storage, notifications, DispatchingWorkspacePicker, undefined, undefined, undefined, {
				canSelectWorkspace: async () => {
					await started.complete();
					await finish.p;
					throw failure;
				},
			}) as DispatchingWorkspacePicker;
			const events: Array<URI | undefined> = [];
			disposables.add(picker.onDidSelectWorkspace(e => events.push(e)));
			const pending = choice === 'recent'
				? picker.dispatchFolder(proposedFolder, provider.id)
				: picker.dispatchItem({ browseAction: action });
			await started.p;
			await finish.complete();

			assert.deepStrictEqual({
				applied: await pending,
				errors: notifications.errors,
				selected: picker.selectedFolderUri?.toString(),
				storedRecents: storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE),
				events,
			}, {
				applied: false,
				errors: [failure.message],
				selected: currentFolder.toString(),
				storedRecents: before,
				events: [],
			});
		});
	}

	test('disposing during browse preserves selection and recent workspaces', async () => {
		const currentFolder = URI.file('/local/current');
		const proposedFolder = URI.file('/local/proposed');
		const result = new DeferredPromise<ISessionWorkspace | undefined>();
		const started = new DeferredPromise<void>();
		const action = {
			...makeBrowseAction('local-1', SESSION_WORKSPACE_GROUP_LOCAL),
			run: async () => { await started.complete(); return result.p; },
		};
		const provider = createMockProvider('local-1', { browseActions: [action] });
		providersService.setProviders([provider]);
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: currentFolder, providerId: provider.id, checked: true }]);
		const before = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
		const picker = createTestPicker(disposables, providersService, storage, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const pending = picker.dispatchItem({ browseAction: action });
		await started.p;
		picker.dispose();
		await result.complete(provider.resolveWorkspace(proposedFolder));

		assert.deepStrictEqual({
			applied: await pending,
			selected: picker.selectedFolderUri?.toString(),
			storedRecents: storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE),
		}, {
			applied: false,
			selected: currentFolder.toString(),
			storedRecents: before,
		});
	});

	test('disposing during trust confirmation preserves selection and recent workspaces', async () => {
		const provider = createMockProvider('local-1');
		providersService.setProviders([provider]);
		const currentFolder = URI.file('/local/current');
		const proposedFolder = URI.file('/local/proposed');
		const confirmation = new DeferredPromise<boolean>();
		const started = new DeferredPromise<void>();
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: currentFolder, providerId: provider.id, checked: true }]);
		const before = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
		const picker = createTestPicker(disposables, providersService, storage, undefined, DispatchingWorkspacePicker, undefined, undefined, undefined, {
			canSelectWorkspace: async () => { await started.complete(); return confirmation.p; },
		}) as DispatchingWorkspacePicker;
		const pending = picker.dispatchFolder(proposedFolder, provider.id);
		await started.p;
		picker.dispose();
		await confirmation.complete(true);

		assert.deepStrictEqual({
			applied: await pending,
			selected: picker.selectedFolderUri?.toString(),
			storedRecents: storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE),
		}, {
			applied: false,
			selected: currentFolder.toString(),
			storedRecents: before,
		});
	});

	test('hiding the popup preserves an in-flight browse choice', async () => {
		const folder = URI.file('/local/browsed');
		const result = new DeferredPromise<ISessionWorkspace | undefined>();
		const started = new DeferredPromise<void>();
		const action = {
			...makeBrowseAction('local-1', SESSION_WORKSPACE_GROUP_LOCAL),
			run: async () => { await started.complete(); return result.p; },
		};
		const provider = createMockProvider('local-1', { browseActions: [action] });
		providersService.setProviders([provider]);
		const storage = disposables.add(new TestStorageService());
		const picker = createTestPicker(disposables, providersService, storage, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const expectedRecents = [{ uri: folder.toJSON(), providerId: provider.id, checked: true }];
		// The private hide hook closes presentation only; disposal cancels selection.
		const popup = picker as unknown as { _hidePicker(): void };
		popup._hidePicker();
		const pending = picker.dispatchItem({ browseAction: action });
		await started.p;
		popup._hidePicker();
		await result.complete(provider.resolveWorkspace(folder));
		const applied = await pending;
		const storedRecents = JSON.parse(storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE)!);

		assert.deepStrictEqual({ applied, selected: picker.selectedFolderUri?.toString(), storedRecents }, {
			applied: true,
			selected: folder.toString(),
			storedRecents: expectedRecents,
		});
	});

	test('a browse result cannot select a provider removed while browsing', async () => {
		const result = new DeferredPromise<ISessionWorkspace | undefined>();
		const started = new DeferredPromise<void>();
		const action = { ...makeBrowseAction('first', SESSION_WORKSPACE_GROUP_REMOTE), run: async () => { await started.complete(); return result.p; } };
		const provider = createMockProvider('first', { browseActions: [action] });
		providersService.setProviders([provider]);
		const picker = createTestPicker(disposables, providersService, undefined, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const row = picker.getItems().find(item => item.item && !item.item.folderUri);
		assert.ok(row?.item);
		const pending = picker.dispatchItem(row!.item!);
		await started.p;
		providersService.setProviders([]);
		await result.complete(provider.resolveWorkspace(URI.file('/owned/browse')));
		const applied = await pending;

		assert.deepStrictEqual({ applied, selected: picker.selectedFolderUri }, { applied: false, selected: undefined });
	});

	test('a browse result cannot select a provider removed during trust confirmation', async () => {
		const confirmation = new DeferredPromise<boolean>();
		const started = new DeferredPromise<void>();
		const folder = URI.file('/owned/confirmed');
		const provider = createMockProvider('first');
		const action = { ...makeBrowseAction('first', SESSION_WORKSPACE_GROUP_REMOTE), run: async () => provider.resolveWorkspace(folder) };
		providersService.setProviders([createMockProvider('first', { browseActions: [action] })]);
		const picker = createTestPicker(disposables, providersService, undefined, undefined, DispatchingWorkspacePicker, undefined, undefined, undefined, {
			canSelectWorkspace: async () => { await started.complete(); return confirmation.p; },
		}) as DispatchingWorkspacePicker;
		const row = picker.getItems().find(item => item.item && !item.item.folderUri);
		assert.ok(row?.item);
		const pending = picker.dispatchItem(row!.item!);
		await started.p;
		providersService.setProviders([]);
		await confirmation.complete(true);

		assert.deepStrictEqual({ applied: await pending, selected: picker.selectedFolderUri }, { applied: false, selected: undefined });
	});

	test('a remote selection cannot select a provider removed during connection', async () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('remoteStatus', RemoteAgentHostConnectionStatus.disconnected);
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<void>();
		const remote = createMockProvider('agenthost-remote-1', {
			connectionStatus: remoteStatus,
			canConnectOnDemand: true,
			connect: async () => { await started.complete(); await finish.p; remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined); },
		});
		const local = createMockProvider('local-1');
		const folder = URI.file('/local/current');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: folder, providerId: local.id, checked: true }]);
		providersService.setProviders([local, remote]);
		const picker = createTestPicker(disposables, providersService, storage, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const pending = picker.dispatchFolder(URI.file('/remote/pending'), remote.id);
		await started.p;
		providersService.setProviders([local]);
		await finish.complete();

		assert.deepStrictEqual({ applied: await pending, selected: picker.selectedFolderUri?.toString() }, { applied: false, selected: folder.toString() });
	});

	test('a recent workspace cannot select an unregistered provider', async () => {
		const provider = createMockProvider('first');
		providersService.setProviders([provider]);
		const picker = createTestPicker(disposables, providersService, undefined, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		providersService.setProviders([]);

		assert.deepStrictEqual({
			applied: await picker.dispatchFolder(URI.file('/owned/unregistered'), provider.id),
			selected: picker.selectedFolderUri,
		}, { applied: false, selected: undefined });
	});

	test('a browse row keeps its action when providers reorder', async () => {
		const calls: string[] = [];
		const firstAction = { ...makeBrowseAction('first', SESSION_WORKSPACE_GROUP_REMOTE), run: async () => { calls.push('first'); return undefined; } };
		const secondAction = { ...makeBrowseAction('second', SESSION_WORKSPACE_GROUP_REMOTE), run: async () => { calls.push('second'); return undefined; } };
		const first = createMockProvider('first', { browseActions: [firstAction] });
		const second = createMockProvider('second', { browseActions: [secondAction] });
		providersService.setProviders([first, second]);
		const picker = createTestPicker(disposables, providersService, undefined, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const row = picker.getItems().find(item => item.item && !item.item.folderUri);
		assert.ok(row?.item);

		providersService.setProviders([second, first]);
		await picker.dispatchItem(row!.item!);

		assert.deepStrictEqual(calls, ['first']);
	});

	test('a browse row from a removed provider cannot invoke its replacement', async () => {
		const calls: string[] = [];
		const firstAction = { ...makeBrowseAction('first', SESSION_WORKSPACE_GROUP_REMOTE), run: async () => { calls.push('first'); return undefined; } };
		const secondAction = { ...makeBrowseAction('second', SESSION_WORKSPACE_GROUP_REMOTE), run: async () => { calls.push('second'); return undefined; } };
		const first = createMockProvider('first', { browseActions: [firstAction] });
		const second = createMockProvider('second', { browseActions: [secondAction] });
		providersService.setProviders([first, second]);
		const picker = createTestPicker(disposables, providersService, undefined, undefined, DispatchingWorkspacePicker) as DispatchingWorkspacePicker;
		const row = picker.getItems().find(item => item.item && !item.item.folderUri);
		assert.ok(row?.item);

		providersService.setProviders([second]);
		await picker.dispatchItem(row!.item!);

		assert.deepStrictEqual(calls, []);
	});

	test('programmatic workspace initialization can avoid persisting recents', () => {
		const localProvider = createMockProvider('local-1');
		const storage = disposables.add(new TestStorageService());
		providersService.setProviders([localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);
		const folder = URI.file('/local/proposed');

		picker.setSelectedWorkspace(folder, { fireEvent: false, persist: false });

		assert.deepStrictEqual({
			selected: picker.selectedFolderUri?.toString(),
			stored: storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE),
		}, {
			selected: folder.toString(),
			stored: undefined,
		});
	});

	test('local provider is never treated as unavailable', () => {
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: true },
		]);

		providersService.setProviders([localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'local-1', 'Local provider workspace should always be selectable');
	});

	test('restore picks the stored workspace when its provider registers after another provider', () => {
		// Regression: previously the picker filtered restore through `activeProviderId`,
		// which auto-locked to whichever provider registered first. If the stored
		// workspace belonged to a provider that registered later than another available
		// provider (for example, local-agent-host registering after default-copilot),
		// the stored entry was filtered out and never restored.
		//
		// Realistic shape: storage holds BOTH a (non-checked) recent for the
		// early-registering provider and a (checked) recent for the late-registering
		// provider. The picker may briefly show the early recent as a fallback, but
		// once the checked entry's provider registers, the picker must upgrade to it.
		const copilotProvider = createMockProvider('default-copilot');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/copilot/old-project'), providerId: 'default-copilot', checked: false },
			{ uri: URI.file('/agent-host/project'), providerId: 'local-agent-host', checked: true },
		]);

		// Construct picker with only the early-registering provider available.
		providersService.setProviders([copilotProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// The fallback may be selected initially (early provider's recent),
		// since the user's checked entry's provider isn't ready yet.
		// Now the late provider arrives.
		const agentHostProvider = createMockProvider('local-agent-host');
		providersService.setProviders([copilotProvider, agentHostProvider]);

		assertSelectedProvider(picker, 'local-agent-host', 'Stored workspace should be restored once its provider registers');
	});

	test('late-registering provider does not move selection out from under user', () => {
		// After the user has explicitly picked a workspace, a provider
		// registering later in the session must not switch the selection to its
		// stored "checked" entry. We only do that auto-upgrade during initial
		// startup before the user has acted.
		const copilotProvider = createMockProvider('default-copilot');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/agent-host/project'), providerId: 'local-agent-host', checked: true },
		]);

		providersService.setProviders([copilotProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// Suppression kicked in: no fallback selection while checked entry is pending.
		assertSelectedProvider(picker, undefined, 'No fallback while checked entry pending');

		// User explicitly picks a Copilot workspace.
		picker.setSelectedWorkspace(URI.file('/copilot/picked'), { fireEvent: false });
		assertSelectedProvider(picker, 'default-copilot', 'User pick is honored');

		// Now the late provider for the (still-stored) checked entry arrives.
		const agentHostProvider = createMockProvider('local-agent-host');
		providersService.setProviders([copilotProvider, agentHostProvider]);

		assertSelectedProvider(picker, 'default-copilot', 'User selection is preserved across late provider registration');
	});
});

suite('AutomationsWorkspacePicker', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	test('selects No workspace and restores a folder through the same picker', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = createMockProvider('local-1');
		const folderUri = URI.file('/local/project');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: folderUri, providerId: provider.id, checked: true }]);
		providersService.setProviders([provider]);

		const picker = createTestPicker(
			disposables,
			providersService,
			storage,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
		) as TestAutomationsWorkspacePicker;
		const state = {
			isQuickChat: false,
			folderUri,
			isolationMode: 'workspace',
			branch: undefined,
		};
		const model = new AutomationIsolationModel(state);
		picker.setTargetModel(model);
		const container = document.createElement('div');
		picker.render(container);
		const readPresentation = () => ({
			triggerLabel: container.querySelector('.sessions-chat-dropdown-label')?.textContent,
			triggerAriaLabel: container.querySelector('.action-label')?.getAttribute('aria-label'),
			items: picker.getItemStates().filter(item => item.label === 'No workspace' || item.label === 'local/project'),
			isQuickChat: model.isQuickChat,
			folderUri: model.folderUri?.toString(),
		});

		const workspace = readPresentation();
		await picker.select('No workspace');
		const noWorkspace = readPresentation();
		await picker.select('local/project');

		assert.deepStrictEqual({
			workspace,
			noWorkspace,
			restoredWorkspace: readPresentation(),
		}, {
			workspace: {
				triggerLabel: 'local/project',
				triggerAriaLabel: 'Automation target, local/project',
				items: [
					{ label: 'No workspace', checked: false },
					{ label: 'local/project', checked: true },
				],
				isQuickChat: false,
				folderUri: folderUri.toString(),
			},
			noWorkspace: {
				triggerLabel: 'No workspace',
				triggerAriaLabel: 'Automation target, No workspace',
				items: [
					{ label: 'No workspace', checked: true },
					{ label: 'local/project', checked: false },
				],
				isQuickChat: true,
				folderUri: undefined,
			},
			restoredWorkspace: {
				triggerLabel: 'local/project',
				triggerAriaLabel: 'Automation target, local/project',
				items: [
					{ label: 'No workspace', checked: false },
					{ label: 'local/project', checked: true },
				],
				isQuickChat: false,
				folderUri: folderUri.toString(),
			},
		});
	});

	test('user workspace selections do not update recent workspaces', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = createMockProvider('local-1');
		const originalFolder = URI.file('/local/original');
		const proposedFolder = URI.file('/local/proposed');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: originalFolder, providerId: provider.id, checked: true },
			{ uri: proposedFolder, providerId: provider.id, checked: false },
		]);
		providersService.setProviders([provider]);
		const before = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
		const picker = createTestPicker(
			disposables,
			providersService,
			storage,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
		) as TestAutomationsWorkspacePicker;
		picker.setTargetModel(new AutomationIsolationModel({
			isQuickChat: false,
			folderUri: originalFolder,
			isolationMode: 'workspace',
			branch: undefined,
		}));

		await picker.select('local/proposed');

		assert.deepStrictEqual({
			selected: picker.selectedFolderUri?.toString(),
			storageUnchanged: storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE) === before,
		}, {
			selected: proposedFolder.toString(),
			storageUnchanged: true,
		});
	});

	test('keeps the previous workspace when trust is declined', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = createMockProvider('local-1');
		const selectedFolder = URI.file('/local/selected');
		const candidateFolder = URI.file('/local/candidate');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: selectedFolder, providerId: provider.id, checked: true },
			{ uri: candidateFolder, providerId: provider.id, checked: false },
		]);
		providersService.setProviders([provider]);
		const trustRequests: Array<{ folderUri: string; providerId: string | undefined }> = [];
		const picker = createTestPicker(
			disposables,
			providersService,
			storage,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
			{},
			undefined,
			undefined,
			{
				canSelectWorkspace: async (folderUri, providerId) => {
					trustRequests.push({ folderUri: folderUri.toString(), providerId });
					return false;
				},
			},
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: false,
			folderUri: selectedFolder,
			isolationMode: 'workspace',
			branch: undefined,
		});
		picker.setTargetModel(model);

		await picker.select('local/candidate');

		assert.deepStrictEqual({
			trustRequests,
			modelFolderUri: model.folderUri?.toString(),
			pickerFolderUri: picker.selectedFolderUri?.toString(),
		}, {
			trustRequests: [{ folderUri: candidateFolder.toString(), providerId: provider.id }],
			modelFolderUri: selectedFolder.toString(),
			pickerFolderUri: selectedFolder.toString(),
		});
	});

	test('a rejected automation workspace trust keeps the previous workspace and recent records', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = createMockProvider('local-1');
		const selectedFolder = URI.file('/local/selected');
		const candidateFolder = URI.file('/local/candidate');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: selectedFolder, providerId: provider.id, checked: true },
			{ uri: candidateFolder, providerId: provider.id, checked: false },
		]);
		providersService.setProviders([provider]);
		const before = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
		const notifications = new RecordingNotificationService();
		const started = new DeferredPromise<void>();
		const finish = new DeferredPromise<void>();
		const failure = new Error('Automation workspace trust failed');
		const requests: Array<{ folderUri: string; providerId: string | undefined }> = [];
		const picker = createTestPicker(
			disposables,
			providersService,
			storage,
			notifications,
			TestAutomationsWorkspacePicker,
			{},
			undefined,
			undefined,
			{
				canSelectWorkspace: async (folderUri, providerId) => {
					requests.push({ folderUri: folderUri.toString(), providerId });
					await started.complete();
					await finish.p;
					throw failure;
				},
			},
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: false,
			folderUri: selectedFolder,
			isolationMode: 'workspace',
			branch: undefined,
		});
		picker.setTargetModel(model);
		const events: Array<string | undefined> = [];
		disposables.add(picker.onDidSelectWorkspace(uri => events.push(uri?.toString())));

		const pending = picker.select('local/candidate');
		await started.p;
		await finish.complete();
		await pending;

		assert.deepStrictEqual({
			requests,
			errors: notifications.errors,
			modelFolderUri: model.folderUri?.toString(),
			pickerFolderUri: picker.selectedFolderUri?.toString(),
			isQuickChat: model.isQuickChat,
			storedRecents: storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE),
			events,
		}, {
			requests: [{ folderUri: candidateFolder.toString(), providerId: provider.id }],
			errors: [failure.message],
			modelFolderUri: selectedFolder.toString(),
			pickerFolderUri: selectedFolder.toString(),
			isQuickChat: false,
			storedRecents: before,
			events: [],
		});
	});

	test('a stale trust grant cannot override a newer No workspace choice', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = createMockProvider('local-1');
		const selectedFolder = URI.file('/local/selected');
		const candidateFolder = URI.file('/local/candidate');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: selectedFolder, providerId: provider.id, checked: true },
			{ uri: candidateFolder, providerId: provider.id, checked: false },
		]);
		providersService.setProviders([provider]);
		const trustResult = new DeferredPromise<boolean>();
		const picker = createTestPicker(
			disposables,
			providersService,
			storage,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
			{},
			undefined,
			undefined,
			{ canSelectWorkspace: () => trustResult.p },
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: false,
			folderUri: selectedFolder,
			isolationMode: 'workspace',
			branch: undefined,
		});
		picker.setTargetModel(model);

		const staleSelection = picker.select('local/candidate');
		await picker.select('No workspace');
		await trustResult.complete(true);
		await staleSelection;

		assert.deepStrictEqual({
			isQuickChat: model.isQuickChat,
			folderUri: model.folderUri,
			pickerFolderUri: picker.selectedFolderUri?.toString(),
		}, {
			isQuickChat: true,
			folderUri: undefined,
			pickerFolderUri: selectedFolder.toString(),
		});
	});

	test('a stale remote selection cannot override a newer No workspace choice', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const localProvider = createMockProvider('local-1');
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('remoteStatus', RemoteAgentHostConnectionStatus.disconnected);
		const connectStarted = new DeferredPromise<void>();
		const finishConnect = new DeferredPromise<void>();
		const remoteProvider = createMockProvider('agenthost-remote-1', {
			connectionStatus: remoteStatus,
			canConnectOnDemand: true,
			connect: async () => {
				await connectStarted.complete();
				await finishConnect.p;
				remoteStatus.set(RemoteAgentHostConnectionStatus.connected, undefined);
			},
		});
		const localFolder = URI.file('/local/project');
		const remoteFolder = URI.file('/remote/project');
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: localFolder, providerId: localProvider.id, checked: true },
			{ uri: remoteFolder, providerId: remoteProvider.id, checked: false },
		]);
		providersService.setProviders([localProvider, remoteProvider]);

		const picker = createTestPicker(
			disposables,
			providersService,
			storage,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: false,
			folderUri: localFolder,
			isolationMode: 'workspace',
			branch: undefined,
		});
		picker.setTargetModel(model);

		const staleSelection = picker.select('remote/project');
		await connectStarted.p;
		await picker.select('No workspace');
		await finishConnect.complete();
		await staleSelection;

		assert.deepStrictEqual({
			isQuickChat: model.isQuickChat,
			folderUri: model.folderUri,
			pickerFolderUri: picker.selectedFolderUri?.toString(),
		}, {
			isQuickChat: true,
			folderUri: undefined,
			pickerFolderUri: localFolder.toString(),
		});
	});

	test('browsing to a folder exits No workspace mode', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const fallbackProvider = createMockProvider('fallback');
		const localProvider = { ...createMockProvider('local-1'), supportsLocalWorkspaces: true };
		const producingProvider = { ...createMockProvider('local-agent-host'), supportsLocalWorkspaces: true };
		const browsedFolder = URI.file('/agent-host/browsed');
		providersService.setProviders([fallbackProvider, localProvider, producingProvider]);
		const trustRequests: Array<{ folderUri: string; providerId: string | undefined }> = [];
		const picker = createTestPicker(
			disposables,
			providersService,
			undefined,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
			{ showOpenDialog: async () => [browsedFolder] },
			undefined,
			undefined,
			{
				canSelectWorkspace: async (folderUri, providerId) => {
					trustRequests.push({ folderUri: folderUri.toString(), providerId });
					return true;
				},
			},
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: true,
			folderUri: undefined,
			isolationMode: undefined,
			branch: undefined,
		});
		picker.setTargetModel(model);

		await picker.select('Select...');

		assert.deepStrictEqual({
			isQuickChat: model.isQuickChat,
			folderUri: model.folderUri?.toString(),
			pickerFolderUri: picker.selectedFolderUri?.toString(),
			trustRequests,
		}, {
			isQuickChat: false,
			folderUri: browsedFolder.toString(),
			pickerFolderUri: browsedFolder.toString(),
			trustRequests: [{ folderUri: browsedFolder.toString(), providerId: producingProvider.id }],
		});
	});

	test('stays in No workspace mode when trust is declined for a browsed folder', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = { ...createMockProvider('local-1'), supportsLocalWorkspaces: true };
		const browsedFolder = URI.file('/local/browsed');
		providersService.setProviders([provider]);
		const picker = createTestPicker(
			disposables,
			providersService,
			undefined,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
			{ showOpenDialog: async () => [browsedFolder] },
			undefined,
			undefined,
			{ canSelectWorkspace: async () => false },
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: true,
			folderUri: undefined,
			isolationMode: undefined,
			branch: undefined,
		});
		picker.setTargetModel(model);

		await picker.select('Select...');

		assert.deepStrictEqual({
			isQuickChat: model.isQuickChat,
			folderUri: model.folderUri,
			pickerFolderUri: picker.selectedFolderUri,
		}, {
			isQuickChat: true,
			folderUri: undefined,
			pickerFolderUri: undefined,
		});
	});

	test('a stale browse result does not request trust after a newer choice', async () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const provider = { ...createMockProvider('local-1'), supportsLocalWorkspaces: true };
		const browsedFolder = URI.file('/local/browsed');
		const browseResult = new DeferredPromise<URI[] | undefined>();
		providersService.setProviders([provider]);
		let trustRequestCount = 0;
		const picker = createTestPicker(
			disposables,
			providersService,
			undefined,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
			{ showOpenDialog: () => browseResult.p },
			undefined,
			undefined,
			{
				canSelectWorkspace: async () => {
					trustRequestCount++;
					return true;
				},
			},
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: true,
			folderUri: undefined,
			isolationMode: undefined,
			branch: undefined,
		});
		picker.setTargetModel(model);

		const staleSelection = picker.select('Select...');
		await picker.select('No workspace');
		await browseResult.complete([browsedFolder]);
		await staleSelection;

		assert.deepStrictEqual({
			isQuickChat: model.isQuickChat,
			folderUri: model.folderUri,
			pickerFolderUri: picker.selectedFolderUri,
			trustRequestCount,
		}, {
			isQuickChat: true,
			folderUri: undefined,
			pickerFolderUri: undefined,
			trustRequestCount: 0,
		});
	});

	test('No workspace is represented as a checked mobile sheet row', () => {
		const providersService = disposables.add(new MockSessionsProvidersService());
		const picker = createTestPicker(
			disposables,
			providersService,
			undefined,
			new TestNotificationService(),
			TestAutomationsWorkspacePicker,
		) as TestAutomationsWorkspacePicker;
		const model = new AutomationIsolationModel({
			isQuickChat: true,
			folderUri: undefined,
			isolationMode: undefined,
			branch: undefined,
		});
		picker.setTargetModel(model);

		const rows = buildMobileWorkspacePickerRows(picker.getItems(), () => { });

		assert.deepStrictEqual(rows.map(row => row.sheetItem), [{
			id: 'item:0',
			label: 'No workspace',
			description: 'Run without a backing workspace',
			icon: Codicon.commentDiscussion,
			checked: true,
			disabled: undefined,
			sectionTitle: undefined,
		}]);
	});

	test('mobile workspace header action dispatches browsing after the sheet closes', async () => {
		const workbench = document.createElement('div');
		document.body.append(workbench);
		disposables.add({ dispose: () => workbench.remove() });
		const trigger = workbench.appendChild(document.createElement('button'));
		const dispatched: IWorkspacePickerItem[] = [];
		const browseAction = makeBrowseAction('local-1', SESSION_WORKSPACE_GROUP_LOCAL, 'Select...');
		const sheet = showMobileWorkspacePickerSheet(
			upcastPartial<IWorkbenchLayoutService>({ mainContainer: workbench }),
			trigger,
			[
				{
					kind: ActionListItemKind.Action,
					label: 'No workspace',
					group: { title: '', icon: Codicon.commentDiscussion },
					item: { run: () => { } },
				},
				{
					kind: ActionListItemKind.Action,
					label: 'Select...',
					group: { title: '', icon: Codicon.folderOpened },
					item: { browseAction },
				},
			],
			item => dispatched.push(item),
			[browseAction],
		);
		const headerAction = workbench.querySelector<HTMLButtonElement>('.mobile-picker-sheet-header-action');
		assert.ok(headerAction);

		headerAction.click();
		await sheet;

		assert.deepStrictEqual(dispatched, [{ browseAction }]);
	});
});

// ---- Tab discovery ----------------------------------------------------------

/** Minimal subclass that exposes the protected `_getAvailableTabs` for testing. */
class TestablePicker extends WorkspacePicker {
	getAvailableTabs(): string[] {
		return this._getAvailableTabs().map(t => t.id);
	}
}

function makeBrowseAction(providerId: string, group: string | undefined, label = 'browse'): ISessionWorkspaceBrowseAction {
	return {
		label,
		group,
		icon: Codicon.folder,
		providerId,
		run: async () => undefined,
	};
}

function createTestablePicker(disposables: DisposableStore, providersService: MockSessionsProvidersService, remoteAgentHostsEnabled = true): TestablePicker {
	const instantiationService = disposables.add(new TestInstantiationService());
	instantiationService.stub(IActionWidgetService, { isVisible: false, hide: () => { }, show: () => { } });
	instantiationService.stub(IContextViewService, { showContextView: () => ({ close: () => { } }), hideContextView: () => { }, layout: () => { } });
	instantiationService.stub(IStorageService, disposables.add(new TestStorageService()));
	instantiationService.stub(IUriIdentityService, { extUri });
	instantiationService.stub(ISessionsProvidersService, providersService);
	instantiationService.stub(IRemoteAgentHostService, {});
	instantiationService.stub(IQuickInputService, {});
	instantiationService.stub(IClipboardService, {});
	instantiationService.stub(IPreferencesService, {});
	instantiationService.stub(IOutputService, {});
	instantiationService.stub(IConfigurationService, new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: remoteAgentHostsEnabled }));
	instantiationService.stub(ICommandService, { executeCommand: async () => { } });
	instantiationService.stub(IFileDialogService, {});
	instantiationService.stub(IContextKeyService, new MockContextKeyService());
	instantiationService.stub(IMenuService, { createMenu: () => ({ onDidChange: Event.None, getActions: () => [], dispose: () => { } }) });
	instantiationService.stub(INotificationService, new TestNotificationService());
	instantiationService.stub(IWorkspacesService, {
		getRecentlyOpened: async () => ({ workspaces: [], files: [] }),
		onDidChangeRecentlyOpened: Event.None,
	});
	instantiationService.stub(ISessionsRecentWorkspacesService, disposables.add(instantiationService.createInstance(SessionsRecentWorkspacesService)));
	instantiationService.stub(ITelemetryService, NullTelemetryService);
	return disposables.add(instantiationService.createInstance(TestablePicker, {}));
}

suite('WorkspacePicker - Tab discovery', () => {

	const disposables = new DisposableStore();
	let providersService: MockSessionsProvidersService;

	setup(() => {
		providersService = new MockSessionsProvidersService();
		disposables.add(providersService);
	});

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns Remote group even when no providers contribute groups', () => {
		providersService.setProviders([createMockProvider('p1')]);
		const picker = createTestablePicker(disposables, providersService);
		assert.deepStrictEqual(picker.getAvailableTabs(), [SESSION_WORKSPACE_GROUP_REMOTE]);
	});

	test('hides Remote group when remote agent hosts are disabled', () => {
		providersService.setProviders([
			createMockProvider('p1', { browseActions: [makeBrowseAction('p1', SESSION_WORKSPACE_GROUP_REMOTE)] }),
		]);
		const picker = createTestablePicker(disposables, providersService, false);
		assert.deepStrictEqual(picker.getAvailableTabs(), []);
	});

	test('orders well-known groups Local first, then alphabetical', () => {
		providersService.setProviders([
			createMockProvider('remote', { browseActions: [makeBrowseAction('remote', SESSION_WORKSPACE_GROUP_REMOTE)] }),
			createMockProvider('cloud', { browseActions: [makeBrowseAction('cloud', 'Cloud')] }),
			createMockProvider('local', { browseActions: [makeBrowseAction('local', SESSION_WORKSPACE_GROUP_LOCAL)] }),
		]);
		const picker = createTestablePicker(disposables, providersService);
		assert.deepStrictEqual(picker.getAvailableTabs(), [SESSION_WORKSPACE_GROUP_LOCAL, 'Cloud', SESSION_WORKSPACE_GROUP_REMOTE]);
	});

	test('deduplicates groups contributed by multiple providers / actions', () => {
		providersService.setProviders([
			createMockProvider('p1', { browseActions: [makeBrowseAction('p1', SESSION_WORKSPACE_GROUP_LOCAL)] }),
			createMockProvider('p2', { browseActions: [makeBrowseAction('p2', SESSION_WORKSPACE_GROUP_LOCAL), makeBrowseAction('p2', SESSION_WORKSPACE_GROUP_LOCAL)] }),
		]);
		const picker = createTestablePicker(disposables, providersService);
		assert.deepStrictEqual(picker.getAvailableTabs(), [SESSION_WORKSPACE_GROUP_LOCAL, SESSION_WORKSPACE_GROUP_REMOTE]);
	});

	test('appends custom group labels after Local', () => {
		providersService.setProviders([
			createMockProvider('p1', { browseActions: [makeBrowseAction('p1', 'Custom A'), makeBrowseAction('p1', SESSION_WORKSPACE_GROUP_LOCAL)] }),
			createMockProvider('p2', { browseActions: [makeBrowseAction('p2', 'Custom B'), makeBrowseAction('p2', SESSION_WORKSPACE_GROUP_REMOTE)] }),
		]);
		const picker = createTestablePicker(disposables, providersService);
		const tabs = picker.getAvailableTabs();
		assert.strictEqual(tabs[0], SESSION_WORKSPACE_GROUP_LOCAL);
		assert.deepStrictEqual(tabs.slice(1).sort(), ['Custom A', 'Custom B', SESSION_WORKSPACE_GROUP_REMOTE]);
	});

	test('ignores browse actions without a group', () => {
		providersService.setProviders([
			createMockProvider('p1', { browseActions: [makeBrowseAction('p1', undefined), makeBrowseAction('p1', SESSION_WORKSPACE_GROUP_LOCAL)] }),
		]);
		const picker = createTestablePicker(disposables, providersService);
		assert.deepStrictEqual(picker.getAvailableTabs(), [SESSION_WORKSPACE_GROUP_LOCAL, SESSION_WORKSPACE_GROUP_REMOTE]);
	});

	test('discovers groups from recent workspaces does not add extra tabs', () => {
		const provider: ISessionsProvider = {
			...createMockProvider('p1'),
			resolveWorkspace: (uri: URI): ISessionWorkspace => ({
				uri,
				label: uri.path,
				icon: Codicon.folder,
				group: 'Cloud',
				folders: [{
					root: uri,
					workingDirectory: uri,
					name: uri.path,
					description: undefined,
					gitRepository: { uri, workTreeUri: undefined, baseBranchName: undefined, gitHubInfo: constObservable(undefined) },
				}],
				requiresWorkspaceTrust: false,
				isVirtualWorkspace: false,
			}),
		};
		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [{ uri: URI.file('/repo'), providerId: 'p1', checked: false }]);
		providersService.setProviders([provider]);

		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IActionWidgetService, { isVisible: false, hide: () => { }, show: () => { } });
		instantiationService.stub(IContextViewService, { showContextView: () => ({ close: () => { } }), hideContextView: () => { }, layout: () => { } });
		instantiationService.stub(IStorageService, storage);
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(ISessionsProvidersService, providersService);
		instantiationService.stub(IRemoteAgentHostService, {});
		instantiationService.stub(IQuickInputService, {});
		instantiationService.stub(IClipboardService, {});
		instantiationService.stub(IPreferencesService, {});
		instantiationService.stub(IOutputService, {});
		instantiationService.stub(IConfigurationService, new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true }));
		instantiationService.stub(ICommandService, { executeCommand: async () => { } });
		instantiationService.stub(IFileDialogService, {});
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(IMenuService, { createMenu: () => ({ onDidChange: Event.None, getActions: () => [], dispose: () => { } }) });
		instantiationService.stub(IWorkspacesService, {
			getRecentlyOpened: async () => ({ workspaces: [], files: [] }),
			onDidChangeRecentlyOpened: Event.None,
		});
		instantiationService.stub(ISessionsRecentWorkspacesService, disposables.add(instantiationService.createInstance(SessionsRecentWorkspacesService)));
		instantiationService.stub(ITelemetryService, NullTelemetryService);
		const picker = disposables.add(instantiationService.createInstance(TestablePicker, {}));
		// Recent workspace group ('Cloud') is not added as a tab — only
		// browse actions and the always-present Remote group contribute tabs.
		assert.deepStrictEqual(picker.getAvailableTabs(), [SESSION_WORKSPACE_GROUP_REMOTE]);
	});
});

suite('WorkspacePicker - Browser accessibility', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const mode of ['flat', 'tabbed'] as const) {
		test(`${mode} browse rows keep the host in their accessible name and dispatch the selected action`, async () => {
			const host = document.createElement('div');
			host.style.width = '500px';
			host.style.height = '400px';
			document.body.appendChild(host);
			disposables.add({ dispose: () => host.remove() });
			const contextView = disposables.add(new WorkspacePickerBrowserContextView(host));
			const providersService = disposables.add(new MockSessionsProvidersService());
			const calls: string[] = [];
			const chosen = new DeferredPromise<void>();
			const actions = ['Fixture Host A', 'Fixture Host B'].map((description, index) => ({
				...makeBrowseAction(index === 0 ? 'agenthost-remote-1' : 'agenthost-fixture-b', SESSION_WORKSPACE_GROUP_REMOTE),
				description,
				run: async () => { calls.push(description); await chosen.complete(); return undefined; },
			}));
			const first = createMockProvider('agenthost-remote-1', {
				connectionStatus: observableValue<RemoteAgentHostConnectionStatus>('firstStatus', RemoteAgentHostConnectionStatus.connected),
				browseActions: [actions[0]],
			});
			providersService.setProviders([
				{
					...first,
					resolveWorkspace: uri => {
						const workspace = first.resolveWorkspace(uri);
						return workspace ? { ...workspace, group: SESSION_WORKSPACE_GROUP_REMOTE } : undefined;
					},
				},
				createMockProvider('agenthost-fixture-b', {
					connectionStatus: observableValue<RemoteAgentHostConnectionStatus>('secondStatus', RemoteAgentHostConnectionStatus.connected),
					browseActions: [actions[1]],
				}),
				createMockProvider('local-1', { browseActions: [makeBrowseAction('local-1', SESSION_WORKSPACE_GROUP_LOCAL)] }),
			]);
			const storage = disposables.add(new TestStorageService());
			seedStorage(storage, [{ uri: URI.file('/remote/current'), providerId: first.id, checked: true }]);
			const picker = createTestPicker(
				disposables, providersService, storage, undefined,
				mode === 'flat' ? FlatBrowserWorkspacePicker : WorkspacePicker,
				undefined, undefined, undefined, undefined, undefined,
				instantiationService => {
					instantiationService.stub(IContextViewService, contextView);
					instantiationService.set(IKeybindingService, new MockKeybindingService());
					instantiationService.set(IHoverService, NullHoverService);
					instantiationService.set(IOpenerService, NullOpenerService);
					instantiationService.stub(ILayoutService, {
						getContainer: () => host,
						mainContainer: host,
					});
					// Instantiate the registered production service in this test's own DI scope.
					const registration = getSingletonServiceDescriptors().find(([id]) => id === IActionWidgetService);
					assert.ok(registration, 'Expected the registered action-widget service');
					const widget = disposables.add(instantiationService.createInstance<IActionWidgetService & IDisposable>(registration[1]));
					instantiationService.stub(IActionWidgetService, widget);
				},
			);
			try {
				picker.render(host);
				picker.showPicker();
				assert.strictEqual(host.querySelector('.sessions-workspace-picker-tabbar') !== null, mode === 'tabbed');
				const rows = Array.from(host.querySelectorAll<HTMLElement>('.actionList .monaco-list-row[role="option"]'));
				const hostRows = ['Fixture Host A', 'Fixture Host B'].map(description => {
					const matches = rows.filter(row => row.textContent?.includes(description));
					assert.strictEqual(matches.length, 1, `Expected one browse row for ${description}`);
					return matches[0];
				});
				const names = hostRows.map(row => row.getAttribute('aria-label'));
				assert.ok(names[0]?.includes('Fixture Host A'), 'First option must announce its host');
				assert.ok(names[1]?.includes('Fixture Host B'), 'Second option must announce its host');
				assert.ok(!names[0]?.includes('Fixture Host B') && !names[1]?.includes('Fixture Host A'), 'Host names must stay with their own rows');
				assert.notStrictEqual(names[0], names[1]);
				hostRows[1].click();
				await chosen.p;
				assert.deepStrictEqual(calls, ['Fixture Host B']);
			} finally {
				contextView.hideContextView();
				picker.dispose();
				host.remove();
			}
		});
	}
});

suite('WorkspacePicker - Trigger and accepted action lifetime', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createBrowserPair(mode: 'flat' | 'tabbed') {
		const host = document.createElement('div');
		host.style.width = '500px';
		host.style.height = '400px';
		document.body.appendChild(host);
		disposables.add({ dispose: () => host.remove() });
		const contextView = disposables.add(new WorkspacePickerBrowserContextView(host));
		const providers = disposables.add(new MockSessionsProvidersService());
		providers.setProviders([
			createMockProvider('agenthost-remote-1', {
				connectionStatus: observableValue<RemoteAgentHostConnectionStatus>('remote', RemoteAgentHostConnectionStatus.connected),
				browseActions: [makeBrowseAction('agenthost-remote-1', SESSION_WORKSPACE_GROUP_REMOTE)],
			}),
			createMockProvider('local-1', { browseActions: [makeBrowseAction('local-1', SESSION_WORKSPACE_GROUP_LOCAL)] }),
		]);
		let sharedActionWidget: (IActionWidgetService & IDisposable) | undefined;
		const create = () => createTestPicker(
			disposables, providers, undefined, undefined,
			mode === 'flat' ? FlatBrowserWorkspacePicker : WorkspacePicker,
			undefined, undefined, undefined, undefined, undefined,
			services => {
				services.stub(IContextViewService, contextView);
				services.set(IKeybindingService, new MockKeybindingService());
				services.set(IHoverService, NullHoverService);
				services.set(IOpenerService, NullOpenerService);
				services.stub(ILayoutService, { getContainer: () => host, mainContainer: host });
				if (!sharedActionWidget) {
					const registration = getSingletonServiceDescriptors().find(([id]) => id === IActionWidgetService);
					assert.ok(registration);
					sharedActionWidget = disposables.add(services.createInstance<IActionWidgetService & IDisposable>(registration[1]));
				}
				services.stub(IActionWidgetService, sharedActionWidget);
			},
		);
		return { host, contextView, first: create(), second: create() };
	}

	for (const mode of ['flat', 'tabbed'] as const) {
		test(`${mode} closes a removed trigger's popup and preserves another picker's popup`, () => {
			const { host, first, second } = createBrowserPair(mode);
			const firstContainer = host.appendChild(document.createElement('div'));
			const secondContainer = host.appendChild(document.createElement('div'));
			let selections = 0;
			disposables.add(first.onDidSelectWorkspace(() => selections++));
			first.render(firstContainer);
			const oldAnchor = firstContainer.querySelector<HTMLElement>('.action-label')!;
			assert.ok(oldAnchor);
			first.showPicker();
			const firstPopup = host.querySelector<HTMLElement>('.context-view')!;
			assert.ok(firstPopup?.querySelector('.actionList'));
			assert.strictEqual(host.querySelector('.sessions-workspace-picker-tabbar') !== null, mode === 'tabbed');
			first.render(firstContainer);
			assert.strictEqual(oldAnchor.isConnected, false);
			assert.strictEqual(firstPopup.isConnected, false, 'The popup must close with its removed anchor');
			assert.strictEqual(selections, 0, 'Replacing a trigger must not clear or pick a workspace');
			first.showPicker();
			assert.ok(host.querySelector('.context-view .actionList'), 'The replacement trigger can open a fresh picker');
			second.render(secondContainer);
			second.showPicker(true);
			const secondPopup = host.querySelector<HTMLElement>('.context-view')!;
			assert.ok(secondPopup?.querySelector('.actionList'));
			first.render(firstContainer);
			assert.strictEqual(secondPopup.isConnected, true, 'An unrelated picker must keep its popup');
			assert.strictEqual(host.querySelector('.context-view'), secondPopup);
			assert.strictEqual(selections, 0);
		});
	}

	function createAcceptedOptions() {
		const providers = disposables.add(new MockSessionsProvidersService());
		const provider = createMockProvider('agenthost-remote-1', {
			connectionStatus: observableValue<RemoteAgentHostConnectionStatus>('remote', RemoteAgentHostConnectionStatus.connected),
			browseActions: [makeBrowseAction('agenthost-remote-1', SESSION_WORKSPACE_GROUP_REMOTE)],
		});
		providers.setProviders([provider]);
		let optionsInvocations = 0;
		const picker = createTestPicker(
			disposables, providers, undefined, undefined, DispatchingWorkspacePicker,
			undefined, undefined, undefined, undefined, undefined,
			services => {
				// Observe the genuine delayed invokeFunction boundary without opening
				// a QuickPick, running remote options, or using real host records.
				services.invokeFunction = () => { optionsInvocations++; return undefined as never; };
			},
		) as DispatchingWorkspacePicker;
		const container = document.createElement('div');
		document.body.appendChild(container);
		disposables.add({ dispose: () => container.remove() });
		picker.render(container);
		Reflect.set(picker, '_activeTab', SESSION_WORKSPACE_GROUP_REMOTE);
		const manage = picker.getItems().find(row => row.item?.commandId === `workspacePicker.remote.${provider.id}`);
		assert.ok(manage?.item?.run, 'Use the actual Manage row producer and its accepted inline action');
		return {
			picker, providers, container,
			accept: () => picker.dispatchItem(manage!.item!),
			get optionsInvocations() { return optionsInvocations; },
		};
	}

	test('an accepted remote-options action survives trigger re-render at the same one-tick delay', () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
		const fixture = createAcceptedOptions();
		const accepted = fixture.accept();
		fixture.picker.render(fixture.container);
		assert.strictEqual(fixture.optionsInvocations, 0, 'Do not open synchronously during widget teardown');
		assert.strictEqual(await accepted, true);
		await timeout(2);
		assert.strictEqual(fixture.optionsInvocations, 1);
	}));

	for (const invalidation of ['dispose', 'provider removal'] as const) {
		test(`accepted remote options do not resume after ${invalidation}`, () => runWithFakedTimers<void>({ useFakeTimers: true }, async () => {
			const fixture = createAcceptedOptions();
			const accepted = fixture.accept();
			if (invalidation === 'dispose') {
				fixture.picker.dispose();
			} else {
				fixture.providers.setProviders([]);
			}
			assert.strictEqual(await accepted, true);
			await timeout(2);
			assert.strictEqual(fixture.optionsInvocations, 0);
		}));
	}
});
