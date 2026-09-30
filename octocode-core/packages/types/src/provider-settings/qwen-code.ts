import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const qwenCodeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.qwenCode,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		qwenCodeApiKey: z.string().optional(),
		qwenCodeBaseUrl: z.string().url().optional(),
		// Kept only to read existing profiles; new OctoCode profiles use API key auth.
		qwenCodeOauthPath: z.string().optional(),
	},
})
