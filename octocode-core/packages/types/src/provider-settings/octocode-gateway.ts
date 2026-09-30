import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OCTOCODE_GATEWAY_MODEL_ID_FIELD = "octoCodeGatewayModelId"

export const octoCodeGatewayProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.octoCodeGateway,
	modelIdKey: OCTOCODE_GATEWAY_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OCTOCODE_GATEWAY_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		octoCodeSessionToken: z.string().optional(),
		[OCTOCODE_GATEWAY_MODEL_ID_FIELD]: z.string().optional(),
		octoCodeGatewayBaseUrl: z.string().optional(),
	},
})
