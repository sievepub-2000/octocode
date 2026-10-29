/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { app } from 'electron';
import { unlinkSync } from 'fs';
import { mkdir, readFile, unlink } from 'fs/promises';
import { release, tmpdir } from 'os';
import { Delayer, ProcessTimeRunOnceScheduler, timeout } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { memoize } from '../../../base/common/decorators.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { hash } from '../../../base/common/hash.js';
import { gt } from '../../../base/common/semver/semver.js';
import * as path from '../../../base/common/path.js';
import { basename } from '../../../base/common/path.js';
import { transform } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import * as pfs from '../../../base/node/pfs.js';
import { killTree } from '../../../base/node/processes.js';
import { getWindowsRelease } from '../../../base/node/windowsVersion.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, DisablementReason, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { AbstractUpdateService, createUpdateURL, getUpdateRequestHeaders, IUpdateURLOptions, UpdateErrorClassification } from './abstractUpdateService.js';
import { getWin32UpdateType } from './win32UpdateType.js';
import { validateWindowsUpdate, verifyWindowsUpdatePackage } from './win32UpdatePackage.js';
import { getGitHubReleaseFeed, GitHubUpdateError } from '../common/githubUpdate.js';
import { gitHubTokenHeaders, requestGitHubAsset, requestGitHubUpdate, verifyGitHubUpdateProof } from './githubUpdate.js';

interface IAvailableUpdate {
	packagePath: string;
	updateFilePath?: string;
	/** File path used to signal the Inno Setup installer to cancel */
	cancelFilePath?: string;
	/** The Inno Setup process that is applying the update in the background */
	updateProcess?: ChildProcess;
}

let _updateType: UpdateType | undefined = undefined;
function getUpdateType(): UpdateType {
	if (typeof _updateType === 'undefined') {
		_updateType = getWin32UpdateType();
	}

	return _updateType;
}

export class Win32UpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private availableUpdate: IAvailableUpdate | undefined;
	private installerHandoffStarted = false;
	private updateCancellationTokenSource: CancellationTokenSource | undefined;
	/** Cancels an in-flight check/download chain (e.g. when updates are disabled at runtime). */
	private checkCancellationTokenSource: CancellationTokenSource | undefined;
	/** Settles when the in-flight check/download chain has fully unwound; used by the cancel path. */
	private checkPromise: Promise<unknown> | undefined;
	private gitHubToken: string | undefined;

	private readonly readyMutexName: string;
	private readonly updatingMutexName: string;
	private readonly setupMutexName: string;

	@memoize
	get cachePath(): Promise<string> {
		const result = path.join(tmpdir(), `${this.productService.applicationName}-${this.productService.quality}-${this.productService.target}-${process.arch}`);
		return mkdir(result, { recursive: true }).then(() => result);
	}

	@memoize
	private get mutex(): Promise<typeof import('@vscode/windows-mutex')> {
		return import('@vscode/windows-mutex');
	}

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProductService productService: IProductService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, true);

		this.readyMutexName = `${productService.win32MutexName}-ready`;
		this.updatingMutexName = `${productService.win32MutexName}-updating`;
		this.setupMutexName = `${productService.win32MutexName}setup`;

		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false; // we cannot apply an update and restart with different args
		}

		if (this.state.type !== StateType.Ready || !this.availableUpdate) {
			return false; // we only handle the relaunch when we have a pending update
		}

		this.logService.trace('update#handleRelaunch(): running raw#quitAndInstall()');
		this.doQuitAndInstall();

		return true;
	}

	protected override async initialize(): Promise<void> {
		if (this.productService.win32VersionedUpdate) {
			const cachePath = await this.cachePath;
			app.setPath('appUpdate', cachePath);
			await this.unlink(path.join(cachePath, 'session-ending.flag'));
		}

		// Send telemetry
		type WindowsUpdateInitEvent = {
			osRelease: string;
			osNodeRelease: string;
		};
		type WindowsUpdateInitClassification = {
			osRelease: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The Windows OS release version from registry.' };
			osNodeRelease: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The Windows OS release version from os.release().' };
			owner: 'dmitriv';
			comment: 'Tracks Windows OS release information during update initialization.';
		};
		const osRelease = await getWindowsRelease();
		const osNodeRelease = release();
		this.telemetryService.publicLog2<WindowsUpdateInitEvent, WindowsUpdateInitClassification>('windowsUpdateInit', { osRelease, osNodeRelease });

		if (this.productService.target === 'user' && await this.nativeHostMainService.isAdmin(undefined)) {
			this.setState(State.Disabled(DisablementReason.RunningAsAdmin));
			this.logService.info('update#ctor - updates are disabled due to running as Admin in user setup');
			return;
		}

		await super.initialize();
	}

	protected override async postInitialize(): Promise<void> {
		if (!this.productService.win32VersionedUpdate) {
			return;
		}
		// Check for pending update from previous session
		// This can happen if the app is quit right after the update has been
		// downloaded and before the update has been applied.
		const exePath = app.getPath('exe');
		const exeDir = path.dirname(exePath);
		const updatingVersionPath = path.join(exeDir, 'updating_version');
		if (await pfs.Promises.exists(updatingVersionPath)) {
			try {
				const updatingVersion = (await readFile(updatingVersionPath, 'utf8')).trim();
				this.logService.info(`update#doCheckForUpdates - application was updating to version ${updatingVersion}`);
				const updatePackagePath = await this.getUpdatePackagePath(updatingVersion);
				if (await pfs.Promises.exists(updatePackagePath)) {
					await this._applySpecificUpdate(updatePackagePath, updatingVersion);
					this.logService.info(`update#doCheckForUpdates - successfully applied update to version ${updatingVersion}`);
				}
			} catch (e) {
				this.logService.error(`update#doCheckForUpdates - could not read ${updatingVersionPath}`, e);
			} finally {
				// updatingVersionPath will be deleted by inno setup.
			}
		} else {
			await this.collectGarbage();
		}
	}

	private async collectGarbage(): Promise<void> {
		if (!this.productService.win32VersionedUpdate) {
			return;
		}

		const fastUpdatesEnabled = this.configurationService.getValue('update.enableWindowsBackgroundUpdates');
		// GC for background updates in system setup happens via inno_setup since it requires elevated permissions.
		if (!fastUpdatesEnabled || this.productService.target !== 'user' || !this.productService.commit) {
			return;
		}

		const exePath = app.getPath('exe');
		const exeDir = path.dirname(exePath);
		const versionedResourcesFolder = this.productService.commit.substring(0, 10);
		const innoUpdater = path.join(exeDir, versionedResourcesFolder, 'tools', 'inno_updater.exe');
		const exeName = basename(exePath);
		await new Promise<void>(resolve => {
			const child = spawn(innoUpdater, ['--gc', exePath, versionedResourcesFolder, exeName], {
				stdio: ['ignore', 'ignore', 'ignore'],
				windowsHide: true,
				timeout: 2 * 60 * 1000
			});
			// Resolve on 'error' too (missing inno_updater / permission denied) so the awaited promise always settles.
			child.once('error', err => {
				this.logService.error('update#collectGarbage - failed to spawn inno_updater', err);
				resolve();
			});
			child.once('exit', () => resolve());
		});
	}

	private getUpdatePlatform(): string {
		let platform = `win32-${process.arch}`;

		if (getUpdateType() === UpdateType.Archive) {
			platform += '-archive';
		} else if (this.productService.target === 'user') {
			platform += '-user';
		}

		return platform;
	}

	protected buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string | undefined {
		return getGitHubReleaseFeed(this.productService.updateUrl)?.url ?? createUpdateURL(this.productService.updateUrl!, this.getUpdatePlatform(), quality, commit, options);
	}

	async setGitHubToken(token: string | undefined): Promise<void> {
		if (token !== undefined) {
			gitHubTokenHeaders(token);
		}
		if (token !== this.gitHubToken) {
			this.gitHubToken = token;
			this.checkCancellationTokenSource?.cancel();
			if (this.state.type === StateType.CheckingForUpdates || this.state.type === StateType.Downloading) {
				this.setState(State.Idle(getUpdateType()));
			}
		}
	}

	override async isLatestVersion(commit?: string, token: CancellationToken = CancellationToken.None): Promise<boolean | undefined> {
		const feed = getGitHubReleaseFeed(this.productService.updateUrl);
		if (!feed) {
			return super.isLatestVersion(commit, token);
		}
		if (!this.quality || this.configurationService.getValue<string>('update.mode') === 'none') {
			return undefined;
		}
		try {
			const update = await requestGitHubUpdate(this.requestService, feed, this.gitHubToken, this.productService.version, this.getUpdatePlatform(), token);
			return !update || update.version === commit;
		} catch {
			return undefined;
		}
	}

	protected doCheckForUpdates(explicit: boolean, pendingCommit?: string): void {
		if (!this.quality) {
			return;
		}
		if (!explicit && !this.gitHubToken && getGitHubReleaseFeed(this.productService.updateUrl)) {
			this.logService.info('update#checkForUpdates: waiting for GitHub update sign-in');
			return;
		}

		const internalOrg = this.getInternalOrg();
		const background = !explicit && !internalOrg;
		const url = this.buildUpdateFeedUrl(this.quality, pendingCommit ?? this.productService.commit!, { background, internalOrg });

		// Only set CheckingForUpdates if we're not already in Overwriting state
		if (this.state.type !== StateType.Overwriting) {
			this.setState(State.CheckingForUpdates(explicit));
		}

		// Track this check/download chain so it can be cancelled if updates are disabled at runtime.
		this.checkCancellationTokenSource?.dispose(true);
		const cts = this.checkCancellationTokenSource = new CancellationTokenSource();
		const token = cts.token;

		const headers = getUpdateRequestHeaders(this.productService.version);
		const gitHubFeed = getGitHubReleaseFeed(this.productService.updateUrl);
		const metadata = gitHubFeed
			? requestGitHubUpdate(this.requestService, gitHubFeed, this.gitHubToken, this.productService.version, this.getUpdatePlatform(), token)
			: this.requestService.request({ url, headers, callSite: 'updateService.win32.checkForUpdates' }, token).then<IUpdate | null>(asJson);
		const promise = metadata
			.then(update => {
				const updateType = getUpdateType();

				if (token.isCancellationRequested) {
					return Promise.resolve(null);
				}

				if (!update || !update.url || !update.version || !update.productVersion || update.version === pendingCommit) {
					// If we were checking for an overwrite update and found nothing newer,
					// restore the Ready state with the pending update
					if (this.state.type === StateType.Overwriting) {
						this._overwrite = false;
						this.setState(State.Ready(this.state.update, this.state.explicit, false));
					} else {
						this.setState(State.Idle(updateType, undefined, explicit || undefined));
					}
					return Promise.resolve(null);
				}

				if (updateType === UpdateType.Archive) {
					this.setState(State.AvailableForDownload(update));
					return Promise.resolve(null);
				}

				// When connection is metered and this is not an explicit check,
				// show update is available but don't start downloading
				if (!explicit && this.meteredConnectionService.isConnectionMetered) {
					this.logService.info('update#doCheckForUpdates - update available but skipping download because connection is metered');
					this.setState(State.AvailableForDownload(update));
					return Promise.resolve(null);
				}

				const startTime = Date.now();
				validateWindowsUpdate(update);
				const downloadUrl = update.url;
				this.setState(State.Downloading(update, explicit, this._overwrite, 0, undefined, startTime));

				return this.cleanup(update.version).then(() => {
					return this.getUpdatePackagePath(update.version).then(updatePackagePath => {
						return pfs.Promises.exists(updatePackagePath).then(async exists => {
							if (exists) {
								try {
									await this.verifyUpdatePackage(updatePackagePath, update);
									return updatePackagePath;
								} catch {
									await unlink(updatePackagePath);
								}
							}

							const downloadPath = `${updatePackagePath}.tmp`;

							const download = gitHubFeed
								? requestGitHubAsset(this.requestService, gitHubFeed, downloadUrl, this.gitHubToken, token)
								: this.requestService.request({ url: downloadUrl, callSite: 'updateService.win32.downloadUpdate' }, token);
							return download
								.then(context => {
									// Get total size from Content-Length header
									const contentLengthHeader = context.res.headers['content-length'];
									const contentLength = typeof contentLengthHeader === 'string' ? contentLengthHeader : undefined;
									const totalBytes = contentLength ? parseInt(contentLength, 10) : undefined;

									// Track downloaded bytes and update state periodically using Delayer
									let downloadedBytes = 0;
									const progressDelayer = new Delayer<void>(500);
									const progressStream = transform<VSBuffer, VSBuffer>(
										context.stream,
										{
											data: data => {
												downloadedBytes += data.byteLength;
												progressDelayer.trigger(() => {
													this.setState(State.Downloading(update, explicit, this._overwrite, downloadedBytes, totalBytes, startTime));
												});
												return data;
											}
										},
										chunks => VSBuffer.concat(chunks)
									);

									return this.fileService.writeFile(URI.file(downloadPath), progressStream)
										.finally(() => progressDelayer.dispose());
								})
								.then(() => this.verifyUpdatePackage(downloadPath, update))
								.then(() => pfs.Promises.rename(downloadPath, updatePackagePath, false /* no retry */))
								.then(() => updatePackagePath);
						});
					}).then(packagePath => {
						if (token.isCancellationRequested) {
							return;
						}

						this.availableUpdate = { packagePath };
						this.saveUpdateMetadata(update);
						this.setState(State.Downloaded(update, explicit, this._overwrite));

						const fastUpdatesEnabled = this.configurationService.getValue('update.enableWindowsBackgroundUpdates');
						if (fastUpdatesEnabled && this.productService.target === 'user') {
							this.doApplyUpdate();
						} else {
							this.setState(State.Ready(update, explicit, this._overwrite));
						}
					});
				});
			})
			.then(undefined, err => {
				// The chain was cancelled because updates are being disabled; leave state to the disable flow.
				if (token.isCancellationRequested || isCancellationError(err)) {
					return;
				}
				if (gitHubFeed && !(err instanceof GitHubUpdateError)) {
					// Transport/stream errors can contain signed CDN URLs. Keep those
					// out of both telemetry and the ordinary update error log.
					err = new GitHubUpdateError('GitHub update failed. Check repository access, network connectivity and installer integrity, then try again.');
				}

				this.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(err))) });
				this.logService.error(err);

				// only show message when explicitly checking for updates
				const message: string | undefined = explicit ? (err.message || err) : undefined;

				// If we were checking for an overwrite update and it failed,
				// restore the Ready state with the pending update
				if (this.state.type === StateType.Overwriting) {
					this._overwrite = false;
					this.setState(State.Ready(this.state.update, this.state.explicit, false));
				} else {
					this.setState(State.Idle(getUpdateType(), message));
				}
			});

		this.checkPromise = promise;

		promise.finally(() => {
			if (this.checkCancellationTokenSource === cts) {
				this.checkCancellationTokenSource = undefined;
			}
			if (this.checkPromise === promise) {
				this.checkPromise = undefined;
			}
			cts.dispose();
		});
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		if (getGitHubReleaseFeed(this.productService.updateUrl)) {
			this.doCheckForUpdates(true);
			return;
		}
		if (state.update.url) {
			this.nativeHostMainService.openExternal(undefined, state.update.url);
		}
		this.setState(State.Idle(getUpdateType()));
	}

	private async getUpdatePackagePath(version: string): Promise<string> {
		const cachePath = await this.cachePath;
		return path.join(cachePath, `CodeSetup-${this.productService.quality}-${version}.exe`);
	}

	private async verifyUpdatePackage(packagePath: string, update: IUpdate): Promise<void> {
		const feed = getGitHubReleaseFeed(this.productService.updateUrl);
		if (feed) {
			verifyGitHubUpdateProof(update, feed, this.getUpdatePlatform());
			if (gt(this.productService.version, update.productVersion!)) {
				throw new GitHubUpdateError('A cached installer must not downgrade the current product');
			}
		}
		await verifyWindowsUpdatePackage(packagePath, update);
	}

	private async validateAvailableUpdate(update: IUpdate, explicit = true): Promise<boolean> {
		if (!getGitHubReleaseFeed(this.productService.updateUrl)) {
			return true;
		}
		try {
			if (!this.availableUpdate) {
				return false;
			}
			await this.verifyUpdatePackage(this.availableUpdate.packagePath, update);
			return true;
		} catch {
			this.availableUpdate = undefined;
			this.logService.error('update#verifyUpdatePackage: signature or integrity verification failed');
			this.setState(State.Idle(getUpdateType(), explicit ? 'The update installer failed signature or integrity verification. Try again or use Backup Update.' : undefined));
			return false;
		}
	}

	override async quitAndInstall(): Promise<void> {
		if (this.state.type === StateType.Ready && !await this.validateAvailableUpdate(this.state.update)) {
			return;
		}
		return super.quitAndInstall();
	}

	private async cleanup(exceptVersion: string | null = null): Promise<void> {
		const filter = exceptVersion ? (one: string) => !(new RegExp(`${this.productService.quality}-${exceptVersion}\\.exe$`).test(one)) : () => true;

		const cachePath = await this.cachePath;
		const versions = await pfs.Promises.readdir(cachePath);

		const promises = versions.filter(filter).map(one => this.unlink(path.join(cachePath, one)));
		await Promise.all(promises);
	}

	protected override async doApplyUpdate(): Promise<void> {
		if (this.state.type !== StateType.Downloaded) {
			return Promise.resolve(undefined);
		}

		if (!this.availableUpdate) {
			return Promise.resolve(undefined);
		}

		const update = this.state.update;
		const explicit = this.state.explicit;
		if (!await this.validateAvailableUpdate(update, explicit)) {
			return;
		}
		this.setState(State.Updating(update, explicit));

		const cachePath = await this.cachePath;
		const sessionEndFlagPath = path.join(cachePath, 'session-ending.flag');
		const cancelFilePath = path.join(cachePath, `cancel.flag`);
		const progressFilePath = path.join(cachePath, `update-progress`);
		this.availableUpdate.updateFilePath = path.join(cachePath, `CodeSetup-${this.productService.quality}-${update.version}.flag`);
		this.availableUpdate.cancelFilePath = cancelFilePath;

		const mutex = await this.mutex;
		const skippedSpawn = this.isInstallerActive(mutex);

		// Skip the spawn if another Inno Setup is already running for this product (background update or a manual installer);
		// otherwise Inno's "Setup is already running" modal pops up. The `-ready` mutex poll below still advances our state when it finishes.
		if (skippedSpawn) {
			this.logService.info('update#doApplyUpdate: another instance is already running setup, waiting for it to finish');
		} else {
			await this.unlink(cancelFilePath);
			await this.unlink(progressFilePath);
			await pfs.Promises.writeFile(this.availableUpdate.updateFilePath, 'flag');

			const child = spawn(this.availableUpdate.packagePath,
				[
					'/verysilent',
					'/log',
					`/update="${this.availableUpdate.updateFilePath}"`,
					`/progress="${progressFilePath}"`,
					`/sessionend="${sessionEndFlagPath}"`,
					`/cancel="${cancelFilePath}"`,
					'/nocloseapplications',
					'/mergetasks=runcode,!desktopicon,!quicklaunchicon'
				],
				{
					detached: true,
					stdio: ['ignore', 'ignore', 'ignore'],
					windowsVerbatimArguments: true,
					env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }
				}
			);

			// Track the process so we can cancel it if needed
			this.availableUpdate.updateProcess = child;

			child.once('exit', () => {
				this.availableUpdate = undefined;
				this.setState(State.Idle(getUpdateType()));
			});
		}

		this.updateCancellationTokenSource?.dispose(true);
		const cts = this.updateCancellationTokenSource = new CancellationTokenSource();
		const token = cts.token;

		const poll = async () => {
			// If we skipped the spawn, the foreign installer was active when we started; treat that as having seen it run
			// so a quick exit (cancel/fail) before the first poll iteration still drops us to Idle.
			let seenRunning = skippedSpawn;
			while (this.state.type === StateType.Updating && !token.isCancellationRequested) {
				if (mutex.isActive(this.readyMutexName)) {
					this.setState(State.Ready(update, explicit, this._overwrite));
					return;
				}

				// Inno gone without `-ready` => install cancelled/failed; drop to Idle.
				if (this.isInstallerActive(mutex)) {
					seenRunning = true;
				} else if (seenRunning) {
					if (!this.availableUpdate?.updateProcess) {
						this.availableUpdate = undefined;
						this.setState(State.Idle(getUpdateType()));
					}
					return;
				}

				try {
					const progressContent = await readFile(progressFilePath, 'utf8');
					if (!token.isCancellationRequested) {
						const [currentStr, maxStr] = progressContent.split(',');
						const currentProgress = parseInt(currentStr, 10);
						const maxProgress = parseInt(maxStr, 10);
						if (!isNaN(currentProgress) && !isNaN(maxProgress) && this.state.type === StateType.Updating) {
							if (this.state.currentProgress !== currentProgress || this.state.maxProgress !== maxProgress) {
								this.setState(State.Updating(update, explicit, currentProgress, maxProgress));
							}
						}
					}
				} catch {
					// Progress file may not exist yet or be locked, ignore
				}

				await timeout(500);
			}
		};

		const cancelTimeout = new ProcessTimeRunOnceScheduler(() => {
			this.logService.warn('update#doApplyUpdate: polling timed out waiting for update to be ready');
			this.setState(State.Idle(getUpdateType(), 'Update did not complete within expected time'));
		}, 60 * 60 * 1000);

		// Poll for progress and ready mutex for 1 hour.
		cancelTimeout.schedule();
		poll().finally(() => {
			cancelTimeout.dispose();
			if (this.updateCancellationTokenSource === cts) {
				this.updateCancellationTokenSource = undefined;
			}
			cts.dispose();
		});
	}

	protected override async cancelUpdate(): Promise<void> {
		// Abort an in-flight check/download so it never reaches the background installer.
		const hadInFlightCheck = !!this.checkCancellationTokenSource;
		const hadPendingUpdate = !!this.availableUpdate;
		this.checkCancellationTokenSource?.dispose(true);
		this.checkCancellationTokenSource = undefined;

		// Only clean up if a check/download was in flight; avoids creating the cache dir when just disabled.
		if (hadInFlightCheck) {
			try {
				await this.checkPromise;
			} catch {
				// the chain swallows its own errors; ignore
			}
			await this.cleanupTempFiles();
		}

		// Tear down any pending (downloaded/applying) update.
		await this.cancelPendingUpdate();

		// Reclaim a partial versioned-resource folder a cancelled update may leave; only after real teardown.
		if (hadInFlightCheck || hadPendingUpdate) {
			this.collectGarbage().catch(err => this.logService.error('update#collectGarbage - failed to collect garbage', err));
		}
	}

	private async cleanupTempFiles(): Promise<void> {
		try {
			const cachePath = await this.cachePath;
			const files = await pfs.Promises.readdir(cachePath);
			await Promise.all(files.filter(file => file.endsWith('.tmp')).map(file => this.unlink(path.join(cachePath, file))));
		} catch (err) {
			this.logService.warn('update#cleanupTempFiles: failed to remove temporary download files', err);
		}
	}

	protected override async cancelPendingUpdate(): Promise<void> {
		if (!this.availableUpdate) {
			return;
		}

		const { updateProcess, updateFilePath, cancelFilePath } = this.availableUpdate;

		// Another instance owns the installer: abort if it's still running so we don't start a new
		// update cycle on top of it; keep `availableUpdate` so quit-and-install can still complete.
		if (!updateProcess && this.isInstallerActive(await this.mutex)) {
			throw new Error('Cannot cancel pending update: another instance is still running setup');
		}

		// Cancel the polling loop
		this.updateCancellationTokenSource?.dispose(true);
		this.updateCancellationTokenSource = undefined;

		if (updateProcess && updateProcess.exitCode === null) {
			this.logService.trace('update#cancelPendingUpdate: cancelling pending update');

			// Remove all listeners to prevent the exit handler from changing state
			updateProcess.removeAllListeners();
			const exitPromise = new Promise<boolean>(resolve => updateProcess.once('exit', () => resolve(true)));

			// Write the cancel file to signal Inno Setup to exit gracefully
			if (cancelFilePath) {
				try {
					await pfs.Promises.writeFile(cancelFilePath, 'cancel');
				} catch (err) {
					this.logService.warn('update#cancelPendingUpdate: failed to write cancel file', err);
				}
			}

			// Wait for the process to exit gracefully, then force-kill if needed
			const pid = updateProcess.pid;
			const exited = await Promise.race([exitPromise, timeout(30 * 1000).then(() => false)]);
			if (pid && !exited) {
				this.logService.trace('update#cancelPendingUpdate: process did not exit gracefully, killing process tree');
				await killTree(pid, true);
			}
		}

		// Clean up the flag file
		await this.unlink(updateFilePath);

		// Clean up the cancel file
		await this.unlink(cancelFilePath);

		this.availableUpdate = undefined;
	}

	protected override doQuitAndInstall(): void {
		if ((this.state.type !== StateType.Ready && this.state.type !== StateType.Restarting) || !this.availableUpdate) {
			return;
		}

		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');

		if (this.availableUpdate.updateFilePath) {
			try {
				unlinkSync(this.availableUpdate.updateFilePath);
			} catch {
				// ignore
			}
		} else {
			if (this.productService.target !== 'user') {
				if (this.installerHandoffStarted) { return; }
				this.installerHandoffStarted = true;
				// ShellExecute honors the system installer's UAC manifest.
				// Electron is already quitting; let the detached Windows shell own the handoff.
				const launcher = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [this.availableUpdate.packagePath], { detached: true, stdio: 'ignore' });
				launcher.on('error', error => this.logService.error('update#quitAndInstall: shell handoff failed', error));
				launcher.unref();
				return;
			}
			spawn(this.availableUpdate.packagePath, ['/silent', '/log', '/mergetasks=runcode,!desktopicon,!quicklaunchicon'], {
				detached: true,
				stdio: ['ignore', 'ignore', 'ignore'],
				env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }
			});
		}
	}

	private async saveUpdateMetadata(update: IUpdate): Promise<void> {
		try {
			const cachePath = await this.cachePath;
			const metadataPath = path.join(cachePath, 'update-metadata.json');
			await pfs.Promises.writeFile(metadataPath, JSON.stringify(update));
		} catch (e) {
			this.logService.error('update#saveUpdateMetadata: failed to save', e);
		}
	}

	private async loadUpdateMetadata(): Promise<IUpdate | undefined> {
		try {
			const cachePath = await this.cachePath;
			const metadataPath = path.join(cachePath, 'update-metadata.json');
			if (await pfs.Promises.exists(metadataPath)) {
				const content = await readFile(metadataPath, 'utf8');
				return JSON.parse(content);
			}
		} catch (e) {
			this.logService.error('update#loadUpdateMetadata: failed to load', e);
		}
		return undefined;
	}

	protected override getUpdateType(): UpdateType {
		return getUpdateType();
	}

	override async _applySpecificUpdate(packagePath: string, commit?: string): Promise<void> {
		if (this.state.type !== StateType.Idle) {
			return;
		}

		const fastUpdatesEnabled = this.configurationService.getValue('update.enableWindowsBackgroundUpdates');
		const update: IUpdate = await this.loadUpdateMetadata() ?? { version: commit ?? 'unknown', productVersion: 'unknown' };
		if (getGitHubReleaseFeed(this.productService.updateUrl)) {
			try {
				await this.verifyUpdatePackage(packagePath, update);
			} catch {
				this.setState(State.Idle(getUpdateType(), 'The cached installer failed signature or integrity verification. Try again or use Backup Update.'));
				return;
			}
		}

		this.setState(State.Downloading(update, true, false));
		this.availableUpdate = { packagePath };
		this.setState(State.Downloaded(update, true, false));

		if (fastUpdatesEnabled && this.productService.target === 'user') {
			this.doApplyUpdate();
		} else {
			this.setState(State.Ready(update, true, false));
		}
	}

	private isInstallerActive(mutex: typeof import('@vscode/windows-mutex')): boolean {
		return mutex.isActive(this.updatingMutexName) || mutex.isActive(this.setupMutexName);
	}

	private async unlink(path: string | undefined): Promise<void> {
		if (path) {
			try {
				await unlink(path);
			} catch (err) {
				const error = err as NodeJS.ErrnoException;
				if (error && error.code === 'ENOENT') {
					return;
				} else {
					this.logService.warn(`update#unlink: failed to unlink ${basename(path)}`, err);
				}
			}
		}
	}
}
