import { SECRET_STATE_KEYS, providerIdentifiers, ProviderSettings } from "@roo-code/types"

/**
 * Returns whether a provider profile is sufficiently configured to leave the
 * welcome/setup gate.
 *
 * `octoCodeIsAuthenticated` is needed for OctoCode Gateway: auth lives in global
 * secret storage (`octocode-auth`), and `octoCodeSessionToken` is not part of
 * `SECRET_STATE_KEYS`, so session-auth alone would otherwise look unconfigured.
 */
export function checkExistKey(config: ProviderSettings | undefined, octoCodeIsAuthenticated?: boolean) {
	if (!config) {
		return false
	}

	// Special case for fake-ai, openai-codex, and qwen-code providers which don't need any configuration.
	const configurationFreeProviders: ProviderSettings["apiProvider"][] = [
		providerIdentifiers.fakeAi,
		providerIdentifiers.openaiCodex,
		providerIdentifiers.qwenCode,
	]
	if (config.apiProvider && configurationFreeProviders.includes(config.apiProvider)) {
		return true
	}

	if (config.apiProvider === providerIdentifiers.kimiCode && (config.kimiCodeAuthMethod ?? "oauth") === "oauth") {
		return true
	}

	// OctoCode Gateway uses session auth (profile token and/or global OctoCode login),
	// not a traditional API key listed in SECRET_STATE_KEYS.
	if (config.apiProvider === providerIdentifiers.octoCodeGateway) {
		return Boolean(config.octoCodeSessionToken) || Boolean(octoCodeIsAuthenticated)
	}

	// Check all secret keys from the centralized SECRET_STATE_KEYS array.
	// Filter out keys that are not part of ProviderSettings (global secrets are stored separately)
	const providerSecretKeys = SECRET_STATE_KEYS
	const hasSecretKey = providerSecretKeys.some((key) => config[key as keyof ProviderSettings] !== undefined)

	// Check additional non-secret configuration properties
	const hasOtherConfig = [
		config.awsRegion,
		config.vertexProjectId,
		config.ollamaModelId,
		config.lmStudioModelId,
		config.vsCodeLmModelSelector,
	].some((value) => value !== undefined)

	return hasSecretKey || hasOtherConfig
}
