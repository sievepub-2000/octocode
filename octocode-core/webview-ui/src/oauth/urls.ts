import { Package } from "@roo/package"

export function getCallbackUrl(provider: string, uriScheme?: string) {
	return encodeURIComponent(`${uriScheme || "vscode"}://${Package.publisher}.${Package.name}/${provider}`)
}

export function getOpenRouterAuthUrl(uriScheme?: string) {
	return `https://openrouter.ai/auth?callback_url=${getCallbackUrl("openrouter", uriScheme)}`
}

export function getRequestyAuthUrl(uriScheme?: string) {
	return `https://app.requesty.ai/oauth/authorize?callback_url=${getCallbackUrl("requesty", uriScheme)}`
}

export function getOctoCodeAuthUrl(_uriScheme?: string, _baseUrl?: string, _deviceName?: string) {
	return "https://octosys.cloud"
}
