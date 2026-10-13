/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import * as sinon from 'sinon';
// eslint-disable-next-line local/code-import-patterns
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright-core';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgentNetworkFilterService } from '../../../networkFilter/common/networkFilterService.js';
import { NullTelemetryServiceShape } from '../../../telemetry/common/telemetryUtils.js';
import { IBrowserViewGroup, IBrowserViewGroupViewEvent } from '../../common/browserViewGroup.js';
import { IInvokeFunctionResult } from '../../common/playwrightService.js';
import { PlaywrightService } from '../../node/playwrightService.js';
import { PlaywrightTab } from '../../node/playwrightTab.js';

class TestBrowserGroup extends Disposable implements IBrowserViewGroup {
	readonly id = 'test-group';
	private readonly added = this._register(new Emitter<IBrowserViewGroupViewEvent>());
	readonly onDidAddView = this.added.event;
	readonly onDidRemoveView = Event.None;
	readonly onDidDestroy = Event.None;
	readonly onCDPMessage = Event.None;

	async addView(viewId: string): Promise<void> { this.added.fire({ viewId }); }
	async removeView(): Promise<void> { }
	async sendCDPMessage(): Promise<void> { }
}

/** Only the external browser/CDP boundary is synthetic; session, tab and async helpers are real. */
class TestPage extends EventEmitter {
	readonly result = new DeferredPromise<string>();
	private dialogClosed = new DeferredPromise<void>();
	private readonly browserContext = new EventEmitter();
	blocked = false;
	beforeGuard: (() => void) | undefined;

	constructor() {
		super();
		Object.assign(this.browserContext, { pages: () => [this.asPage()] });
	}

	asPage(): Page { return this as unknown as Page; }
	context(): BrowserContext { return this.browserContext as unknown as BrowserContext; }
	url(): string { return 'https://owned.test/'; }
	async consoleMessages(): Promise<[]> { return []; }
	async pageErrors(): Promise<[]> { return []; }
	async ariaSnapshot(): Promise<string> { return ''; }
	async title(): Promise<string> { return ''; }
	setDefaultTimeout(): void { }
	waitForFunction(): Promise<void> { return this.dialogClosed.p; }

	openDialog(): void {
		this.dialogClosed = new DeferredPromise<void>();
		this.emit('dialog', {
			accept: () => this.dialogClosed.complete(),
			dismiss: () => this.dialogClosed.complete(),
			type: () => 'alert', message: () => 'owned dialog',
		} as unknown as Dialog);
	}
}

suite('PlaywrightService deferred results', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let store: DisposableStore;
	let service: PlaywrightService;
	let page: TestPage;
	let telemetry: sinon.SinonSpy;
	let clock: sinon.SinonFakeTimers;
	const sessionId = 'test-session';
	const pageId = 'test-page';
	const tick = () => new Promise<void>(resolve => setImmediate(resolve));

	setup(async () => {
		clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		store = disposables.add(new DisposableStore());
		page = new TestPage();
		const browser = Object.assign(new EventEmitter(), {
			contexts: () => [page.context()], close: async () => { },
		}) as unknown as Browser;
		sinon.stub(chromium, 'connectOverCDP').resolves(browser);
		const runAgainstPage = sinon.spy(PlaywrightTab.prototype, 'safeRunAgainstPage');
		const group = new TestBrowserGroup();
		const filter: IAgentNetworkFilterService = {
			_serviceBrand: undefined, onDidChange: Event.None,
			isUriAllowed: () => { page.beforeGuard?.(); return !page.blocked; },
			formatError: () => 'owned policy denied',
		};
		const telemetryService = new NullTelemetryServiceShape();
		telemetry = sinon.spy(telemetryService, 'publicLog2');
		const logService = new class extends mock<ILogService>() {
			override info(): void { }
			override debug(): void { }
		};
		service = store.add(new PlaywrightService(1, { createGroup: async () => group }, logService, filter, telemetryService));
		await service.startTrackingPage(pageId);
		await service.getSummary(sessionId, pageId);
		// PlaywrightTab has no dispose method; the fixture owns its dialog emitter.
		store.add((runAgainstPage.firstCall.thisValue as PlaywrightTab)['_onDialogStateChanged']);
	});

	teardown(async () => {
		await page.result.complete('owned teardown');
		store.dispose();
		await tick();
		sinon.restore();
	});

	async function defer(): Promise<string> {
		const running = service.invokeFunction(sessionId, pageId, '(_page, result) => result', [page.result.p], 1000);
		await tick();
		page.openDialog();
		const result = await running;
		assert.match(result.error!, /interrupted by a dialog/);
		assert.ok(result.deferredResultId);
		return result.deferredResultId;
	}

	async function assertConsumed(id: string): Promise<void> {
		await assert.rejects(service.waitForDeferredResult(sessionId, id, 1000), /No deferred result found/);
	}

	test('dialog rejection preserves the result for a successful retry and consumes it once', async () => {
		const id = await defer();
		const early = await service.waitForDeferredResult(sessionId, id, 1000);
		assert.strictEqual(early.error, 'Cannot perform action while a dialog is open');
		assert.strictEqual(early.deferredResultId, undefined);
		assert.strictEqual(telemetry.firstCall.args[1].resumeCount, 0);
		await service.replyToDialog(sessionId, pageId, true);
		await page.result.complete('owned result');
		const resumed = await service.waitForDeferredResult(sessionId, id, 1000);
		assert.deepStrictEqual([resumed.result, resumed.error, resumed.deferredResultId], ['owned result', undefined, undefined]);
		await assertConsumed(id);
	});

	test('policy rejection preserves the deferred result until the guard allows the page', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		page.blocked = true;
		const blocked = await service.waitForDeferredResult(sessionId, id, 1000);
		assert.deepStrictEqual([blocked.error, blocked.deferredResultId], ['owned policy denied', undefined]);
		page.blocked = false;
		await page.result.complete('owned allowed result');
		assert.strictEqual((await service.waitForDeferredResult(sessionId, id, 1000)).result, 'owned allowed result');
		await assertConsumed(id);
	});

	test('a pending result reuses its ID across timeouts and is eventually consumed', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		for (let i = 0; i < 2; i++) {
			const waiting = service.waitForDeferredResult(sessionId, id, 5);
			await clock.tickAsync(5);
			const pending = await waiting;
			assert.deepStrictEqual([pending.result, pending.error, pending.deferredResultId], [undefined, undefined, id]);
		}
		await page.result.complete('owned settled result');
		assert.strictEqual((await service.waitForDeferredResult(sessionId, id, 1000)).result, 'owned settled result');
		await assertConsumed(id);
	});

	test('a dialog interrupting an admitted wait keeps the same ID', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		const waiting = service.waitForDeferredResult(sessionId, id, 1000);
		await tick();
		page.openDialog();
		const interrupted = await waiting;
		assert.match(interrupted.error!, /interrupted by a dialog/);
		assert.strictEqual(interrupted.deferredResultId, id);
		await service.replyToDialog(sessionId, pageId, true);
		await page.result.complete('owned after second dialog');
		assert.strictEqual((await service.waitForDeferredResult(sessionId, id, 1000)).result, 'owned after second dialog');
		await assertConsumed(id);
	});

	test('an original promise rejection is returned as an error and consumed once', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		const waiting = service.waitForDeferredResult(sessionId, id, 1000);
		await tick();
		await page.result.error(new Error('owned deferred failure'));
		const result = await waiting;
		assert.deepStrictEqual([result.result, result.error, result.deferredResultId], [undefined, 'owned deferred failure', undefined]);
		await assertConsumed(id);
	});

	test('concurrent readers cannot both consume the same result', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		await page.result.complete('owned single winner');
		const reads = await Promise.allSettled([
			service.waitForDeferredResult(sessionId, id, 1000),
			service.waitForDeferredResult(sessionId, id, 1000),
		]);
		const successes = reads.filter((read): read is PromiseFulfilledResult<IInvokeFunctionResult> => read.status === 'fulfilled' && read.value.result === 'owned single winner');
		assert.strictEqual(successes.length, 1);
		const loser = reads.find(read => read !== successes[0])!;
		if (loser.status === 'fulfilled') {
			assert.match(loser.value.error!, /No deferred result found/);
			assert.strictEqual(loser.value.deferredResultId, undefined);
		} else {
			assert.match(loser.reason.message, /No deferred result found/);
		}
		await assertConsumed(id);
	});

	test('expiry after lookup and before the callback rejects without a new ID', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		await page.result.complete('owned expired result');
		page.beforeGuard = () => { page.beforeGuard = undefined; clock.tick(300_000); };
		// Keep this wait's timeout beyond the cleanup deadline, so only entry expiry wins the race.
		const expired = await service.waitForDeferredResult(sessionId, id, 600_000);
		assert.match(expired.error!, /No deferred result found/);
		assert.strictEqual(expired.deferredResultId, undefined);
		await assertConsumed(id);
	});

	test('a rejected wait preserves the original cleanup deadline', async () => {
		const id = await defer();
		await clock.tickAsync(270_000);
		const early = await service.waitForDeferredResult(sessionId, id, 1000);
		assert.strictEqual(early.error, 'Cannot perform action while a dialog is open');
		await clock.tickAsync(30_001);
		await assertConsumed(id);
		await service.replyToDialog(sessionId, pageId, true);
	});

	test('an immediate failed invocation logs once and returns its original error without an ID', async () => {
		const running = service.invokeFunction(sessionId, pageId, '(_page, result) => result', [page.result.p], 1000);
		await tick();
		await page.result.error(new Error('owned immediate failure'));
		const result = await running;
		await tick();
		assert.deepStrictEqual([result.result, result.error, result.deferredResultId], [undefined, 'owned immediate failure', undefined]);
		assert.strictEqual(telemetry.callCount, 1);
		assert.deepStrictEqual([telemetry.firstCall.args[1].success, telemetry.firstCall.args[1].wasDeferred, telemetry.firstCall.args[1].resumeCount], [0, 0, 0]);
	});

	test('failure after repeated timeouts preserves its ID until one final read and logs once', async () => {
		const id = await defer();
		await service.replyToDialog(sessionId, pageId, true);
		for (let i = 0; i < 2; i++) {
			const waiting = service.waitForDeferredResult(sessionId, id, 5);
			await clock.tickAsync(5);
			assert.strictEqual((await waiting).deferredResultId, id);
		}
		assert.strictEqual(telemetry.callCount, 0);
		const waiting = service.waitForDeferredResult(sessionId, id, 1000);
		await tick();
		await page.result.error(new Error('owned failure after timeouts'));
		const result = await waiting;
		await tick();
		assert.deepStrictEqual([result.result, result.error, result.deferredResultId], [undefined, 'owned failure after timeouts', undefined]);
		await assertConsumed(id);
		assert.strictEqual(telemetry.callCount, 1);
		assert.deepStrictEqual([telemetry.firstCall.args[1].success, telemetry.firstCall.args[1].wasDeferred, telemetry.firstCall.args[1].resumeCount], [0, 1, 3]);
	});
});
