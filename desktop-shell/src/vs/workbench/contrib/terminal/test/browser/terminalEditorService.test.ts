/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/
import { strictEqual } from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorCloseContext, IEditorCloseEvent } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ITerminalInstance } from '../../browser/terminal.js';
import { TerminalEditorInput } from '../../browser/terminalEditorInput.js';
import { TerminalEditorService } from '../../browser/terminalEditorService.js';

suite('Workbench - TerminalEditorService placement', () => {
    const store = ensureNoDisposablesAreLeakedInTestSuite();

    test('moving a live terminal keeps its resource registered until a real close', () => {
        const instantiationService = workbenchInstantiationService(undefined, store);
        const close = store.add(new Emitter<IEditorCloseEvent>());
        instantiationService.stub(IEditorService, 'onDidCloseEditor', close.event);
        const service = store.add(instantiationService.createInstance(TerminalEditorService));
        const instance = {
            instanceId: 42, resource: URI.parse('vscode-terminal:/workspace/42'),
            onDidFocus: Event.None, onDisposed: Event.None,
            capabilities: { onDidChangeCapabilities: Event.None },
        } as unknown as ITerminalInstance;
        const input = Object.create(TerminalEditorInput.prototype) as TerminalEditorInput;
        Reflect.set(input, '_terminalInstance', instance);
        const register = Reflect.get(service, '_registerInstance') as (key: string, input: TerminalEditorInput, instance: ITerminalInstance) => void;
        register.call(service, instance.resource.path, input, instance);
        service.setActiveInstance(instance);

        close.fire({ editor: input, context: EditorCloseContext.MOVE, groupId: 1, index: 0, sticky: false });
        strictEqual(service.getInputFromResource(instance.resource), input);
        strictEqual(service.instances.includes(instance), true);
        strictEqual(service.activeInstance, instance);

        close.fire({ editor: input, context: EditorCloseContext.UNKNOWN, groupId: 3, index: 0, sticky: false });
        strictEqual(service.instances.includes(instance), false);
        strictEqual(service.activeInstance, undefined);
    });
});
