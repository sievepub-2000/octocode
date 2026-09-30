/**
 * "OpenAI" (openai-native) is the entry for OpenAI's own service. Local and
 * self-hosted servers (oMLX, vLLM, llama.cpp, LM gateways...) speak the
 * OpenAI-compatible Chat Completions dialect and belong to the
 * "OpenAI Compatible" (openai) entry, which discovers models from
 * `GET {baseUrl}/models` and does not apply OpenAI-only request features.
 *
 * Profiles saved before this distinction was enforced may point the native
 * entry at such a server. This moves them to the compatible entry without
 * losing the endpoint, key or model the user chose.
 */

const OFFICIAL_OPENAI_HOST_SUFFIX = "openai.com"

export function isOfficialOpenAiBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl || baseUrl.trim() === "") {
		return true
	}

	try {
		const host = new URL(baseUrl.trim()).hostname.toLowerCase()
		return host === OFFICIAL_OPENAI_HOST_SUFFIX || host.endsWith(`.${OFFICIAL_OPENAI_HOST_SUFFIX}`)
	} catch {
		return false
	}
}

/**
 * Returns the migrated profile, or `undefined` when the profile does not need
 * to change.
 */
export function migrateOpenAiNativeCustomEndpoint<T extends Record<string, unknown>>(config: T): T | undefined {
	if (config.apiProvider !== "openai-native") {
		return undefined
	}

	const baseUrl = typeof config.openAiNativeBaseUrl === "string" ? config.openAiNativeBaseUrl : undefined
	if (isOfficialOpenAiBaseUrl(baseUrl)) {
		return undefined
	}

	const {
		openAiNativeBaseUrl: _baseUrl,
		openAiNativeApiKey,
		openAiNativeServiceTier: _serviceTier,
		apiModelId,
		...rest
	} = config

	return {
		...rest,
		apiProvider: "openai",
		openAiBaseUrl: baseUrl!.trim(),
		...(typeof openAiNativeApiKey === "string" && openAiNativeApiKey !== ""
			? { openAiApiKey: openAiNativeApiKey }
			: {}),
		...(typeof apiModelId === "string" && apiModelId !== "" ? { openAiModelId: apiModelId } : {}),
	} as unknown as T
}
