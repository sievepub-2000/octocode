/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IDocumentDiff } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IProgressService, IProgressOptions, IProgress, IProgressStep } from '../../../../../platform/progress/common/progress.js';
import { TextFileEditorModel } from '../../../../services/textfile/common/textFileEditorModel.js';
import { TextFileEditorModelManager } from '../../../../services/textfile/common/textFileEditorModelManager.js';
import { IResolvedTextFileEditorModel } from '../../../../services/textfile/common/textfiles.js';
import { TestServiceAccessor, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IChatEditingService } from '../../../chat/common/editing/chatEditingService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { QuickDiffModel } from '../../browser/quickDiffModel.js';
import { IQuickDiffService, QuickDiff } from '../../common/quickDiff.js';
import { ISCMService } from '../../common/scm.js';

suite('QuickDiffModel lifecycle', () => {
	function service<T extends object>(values: Partial<T>): T {
		return Object.assign(new (mock<T>())(), values);
	}

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let model: TextFileEditorModel;
	let quickDiff: QuickDiffModel;
	let providers: DeferredPromise<QuickDiff[]>;
	let computation: DeferredPromise<IDocumentDiff | null>;
	let runProgress: (() => Promise<unknown>) | undefined;
	let computationStarted: DeferredPromise<void>;
	let delayProgress: boolean;
	let progressStarted: DeferredPromise<void>;
	let accessor: TestServiceAccessor;

	setup(async () => {
		const services = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, services);
		accessor = instantiationService.createInstance(TestServiceAccessor);
		services.add(accessor.textFileService.files as TextFileEditorModelManager);
		model = services.add(instantiationService.createInstance(TextFileEditorModel, URI.file('/quick-diff-lifecycle.txt'), 'utf8', undefined));
		accessor.workingCopyService.testUnregisterWorkingCopy(model);
		await model.resolve();
		assert.ok(model.isResolved());
		providers = new DeferredPromise<QuickDiff[]>();
		computation = new DeferredPromise<IDocumentDiff | null>();
		computationStarted = new DeferredPromise<void>();
		progressStarted = new DeferredPromise<void>();
		delayProgress = false;
		runProgress = undefined;
		const progress = service<IProgressService>({
			_serviceBrand: undefined,
			withProgress: <R>(_options: IProgressOptions, task: (progress: IProgress<IProgressStep>) => Promise<R>): Promise<R> => {
				const run = () => task({ report() { } });
				if (!delayProgress) {
					return run();
				}
				const pending = new DeferredPromise<unknown>();
				runProgress = async () => {
					try { await pending.complete(await run()); } catch (error) { await pending.error(error); }
				};
				void progressStarted.complete();
				return pending.p as Promise<R>;
			}
		});
		quickDiff = services.add(new QuickDiffModel(
			model as IResolvedTextFileEditorModel, { algorithm: 'advanced' },
			service<ISCMService>({ repositories: [], onDidAddRepository: Event.None, onDidRemoveRepository: Event.None }),
			service<IQuickDiffService>({ onDidChangeQuickDiffProviders: Event.None }),
			service<IEditorWorkerService>({
				_serviceBrand: undefined,
				canComputeDirtyDiff: () => true,
				computeDiff: async () => { await computationStarted.complete(); return computation.p; }
			}),
			service<IConfigurationService>({ onDidChangeConfiguration: Event.None, getValue: <T>() => 'false' as T }),
			service<ITextModelService>({}),
			service<IChatEditingService>({ editingSessionsObs: observableValue('quick diff test sessions', []) }),
			progress,
			service<IWorkbenchEnvironmentService>({ isSessionsWindow: false })
		));
		quickDiff['_diffDelayer'].cancel();
		quickDiff['getQuickDiffsPromise'] = () => providers.p;
	});

	teardown(() => quickDiff['_diffDelayer'].cancel());

	test('queued progress callback after real file-model disposal does not read a null text model', async () => {
		delayProgress = true;
		const result = quickDiff['diff']();
		model.dispose();
		assert.strictEqual(model.textEditorModel, null);
		await runProgress!();
		assert.strictEqual(await result, null);
	});

	test('file disposal while waiting for providers discards the result', async () => {
		const result = quickDiff['diff']();
		model.dispose();
		await providers.complete([]);
		assert.strictEqual(await result, null);
	});

	test('file disposal while a worker computes discards the result', async () => {
		const result = quickDiff['diff']();
		await providers.complete([{ id: 'test', label: 'test', kind: 'primary', originalResource: URI.file('/original.txt') }]);
		await computationStarted.p;
		model.dispose();
		await computation.complete(null);
		assert.strictEqual(await result, null);
	});

	test('content changes while a worker computes discard the obsolete version', async () => {
		const result = quickDiff['diff']();
		await providers.complete([{ id: 'test', label: 'test', kind: 'primary', originalResource: URI.file('/original.txt') }]);
		await computationStarted.p;
		model.textEditorModel!.setValue('a newer edit');
		await computation.complete(null);
		assert.strictEqual(await result, null);
	});

	test('a resolved current model still produces a result with its actual version', async () => {
		const versionId = model.textEditorModel!.getVersionId();
		const result = quickDiff['diff']();
		await providers.complete([]);
		assert.strictEqual((await result)?.versionId, versionId);
	});

	test('replacement text model with the same version cannot accept the old result', async () => {
		const original = model.textEditorModel!;
		const result = quickDiff['diff']();
		await providers.complete([{ id: 'test', label: 'test', kind: 'primary', originalResource: URI.file('/original.txt') }]);
		await computationStarted.p;
		const replacement = disposables.add(accessor.modelService.createModel('replacement', null, URI.file('/replacement.txt')));
		assert.strictEqual(replacement.getVersionId(), original.getVersionId());
		// The real wrapper getter resolves its handle through the model service.
		Reflect.set(model, 'textEditorModelHandle', replacement.uri);
		assert.strictEqual(model.textEditorModel, replacement);
		await computation.complete(null);
		assert.strictEqual(await result, null);
		Reflect.set(model, 'textEditorModelHandle', original.uri);
	});

	test('the throttled public change event stays quiet after a queued file is disposed', async () => {
		delayProgress = true;
		let events = 0;
		disposables.add(quickDiff.onDidChange(() => events++));
		quickDiff['triggerDiff']();
		await progressStarted.p;
		model.dispose();
		await runProgress!();
		await timeout(0);
		assert.strictEqual(events, 0);
	});

	test('the throttled current model publishes changes and the actual version', async () => {
		const changed = new DeferredPromise<void>();
		disposables.add(quickDiff.onDidChange(() => { void changed.complete(); }));
		quickDiff['triggerDiff']();
		await providers.complete([]);
		await changed.p;
		assert.strictEqual(quickDiff.changesVersionId, model.textEditorModel!.getVersionId());
		assert.deepStrictEqual(quickDiff.changes, []);
	});

	test('a current worker diff preserves its nonempty change and provider mapping', async () => {
		const result = quickDiff['diff']();
		await providers.complete([{ id: 'test', label: 'test', kind: 'primary', originalResource: URI.file('/original.txt') }]);
		await computationStarted.p;
		const change = new DetailedLineRangeMapping(new LineRange(1, 2), new LineRange(1, 2), undefined);
		await computation.complete({ changes: [change], moves: [], identical: false, quitEarly: false });
		const diff = await result;
		assert.ok(diff);
		assert.strictEqual(diff.changes.length, 1);
		assert.strictEqual(diff.changes[0].change2, change);
		assert.strictEqual(diff.changes[0].providerId, 'test');
		assert.deepStrictEqual(diff.mapChanges.get('test'), [0]);
		assert.strictEqual(diff.versionId, model.textEditorModel!.getVersionId());
	});
});
