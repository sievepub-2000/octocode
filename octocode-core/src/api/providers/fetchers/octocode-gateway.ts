import axios from "axios"

import type { ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { getOctoCodeBaseUrl, resolveOctoCodeGatewaySessionToken } from "../../../services/octocode-auth"

import {
	type VercelAiGatewayModel,
	parseVercelAiGatewayModel,
	vercelAiGatewayModelsResponseSchema,
} from "./vercel-ai-gateway"

// Bound model discovery so a network stall can't hang provider initialization paths.
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * getOctoCodeGatewayModels
 *
 * Fetches models from the OctoCode Gateway API. Requires authentication via the octo_ext_ token.
 */

export async function getOctoCodeGatewayModels(options?: ApiHandlerOptions): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}
	const baseURL = options?.octoCodeGatewayBaseUrl ?? `${getOctoCodeBaseUrl()}/api/gateway/v1`

	const sessionToken = resolveOctoCodeGatewaySessionToken(options?.octoCodeSessionToken)
	if (!sessionToken) {
		return models
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${sessionToken}`,
	}

	try {
		const response = await axios.get(`${baseURL}/models`, {
			headers,
			timeout: MODEL_DISCOVERY_TIMEOUT_MS,
		})
		const result = vercelAiGatewayModelsResponseSchema.safeParse(response.data)

		if (!result.success) {
			console.error(`OctoCode Gateway models response is invalid ${JSON.stringify(result.error.format())}`)
			return models
		}

		for (const model of result.data.data) {
			const { id } = model

			// Only include language models for chat inference.
			// Embedding models are statically defined in embeddingModels.ts.
			if (model.type !== "language") {
				continue
			}

			models[id] = parseOctoCodeGatewayModel({ id, model })
		}
	} catch (error) {
		// Log only safe fields; never serialize the full error object because it
		// includes request config/headers which carry the bearer session token.
		const err = error as {
			message?: string
			name?: string
			code?: string
			response?: { status?: number; statusText?: string }
		}
		console.error(
			`Error fetching OctoCode Gateway models: name=${err.name ?? "Error"} code=${err.code ?? "unknown"} status=${err.response?.status ?? "unknown"} ${err.response?.statusText ?? ""} message=${err.message ?? "unknown error"}`,
		)
	}

	return models
}

/**
 * parseOctoCodeGatewayModel
 *
 * Parses a OctoCode Gateway model into ModelInfo format.
 * OctoCode Gateway returns the same format as Vercel AI Gateway, so we can reuse the parsing logic.
 */

export const parseOctoCodeGatewayModel = ({ id, model }: { id: string; model: VercelAiGatewayModel }): ModelInfo => {
	return parseVercelAiGatewayModel({ id, model })
}
