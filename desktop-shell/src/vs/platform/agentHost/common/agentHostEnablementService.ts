/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../base/common/observable.js';
import * as nls from '../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { RawContextKey } from '../../contextkey/common/contextkey.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Registry } from '../../registry/common/platform.js';

/** @internal Only the enablement service may read this configuration value at runtime. */
const agentHostEnabledSettingId = 'chat.agentHost.enabled';

/** Context key set by {@link IAgentHostEnablementService}. Use in `when` clauses to gate UI on whether the agent host is enabled. */
export const AGENT_HOST_ENABLED_CONTEXT_KEY = new RawContextKey<boolean>('agentHostEnabled', false, { type: 'boolean', description: nls.localize('agentHostEnabled', "Whether the local agent host process is enabled.") });

export const IAgentHostEnablementService = createDecorator<IAgentHostEnablementService>('agentHostEnablementService');

export interface IAgentHostEnablementService {
	readonly _serviceBrand: undefined;
	/**
	 * Whether Agent Host features are enabled in this runtime.
	 * This can transition from `false` to `true` only when explicitly enabled.
	 */
	readonly enabled: IObservable<boolean>;
}

// Register the provider-neutral Agent Host opt-in.
// Intentionally kept in this file so the setting ID stays internal.
// Loaded by:
//   - `electronAgentHostStarter.ts` (main process, for default value awareness)
//   - `platform/agentHost/browser/agentHostEnablementService.ts` (renderer, via import)
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'chatAgentHost',
	title: nls.localize('chatAgentHostConfigurationTitle', "Chat Agent Host"),
	type: 'object',
	properties: {
		[agentHostEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('chat.agentHost.enabled', "Enables the provider-neutral agent host protocol service."),
			default: false,
			tags: ['experimental', 'advanced'],
		},
	}
});
