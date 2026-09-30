import * as vscode from "vscode"

import { t } from "../i18n"

const OCTOCODE_TOKEN_KEY = "octocode-session-token"
const OCTOCODE_USER_NAME_KEY = "octocode-user-name"
const OCTOCODE_USER_EMAIL_KEY = "octocode-user-email"
const OCTOCODE_USER_IMAGE_KEY = "octocode-user-image"

let secretStorage: vscode.SecretStorage | undefined

// In-memory cache for synchronous access in OctoCodeHandler hot path
let _cachedToken: string | undefined = undefined
let _sessionCleared = false
let _cachedUserName: string | undefined = undefined
let _cachedUserEmail: string | undefined = undefined
let _cachedUserImage: string | undefined = undefined

export function isOctoCodeAuthenticationRequired(
	value = process.env.OCTOCODE_REQUIRE_AUTHENTICATION,
): boolean {
	const normalized = value?.trim().toLowerCase()
	if (!normalized || normalized === "false") return false
	if (normalized === "true") return true
	throw new Error("OCTOCODE_REQUIRE_AUTHENTICATION must be true or false.")
}

export function assertOctoCodeAuthenticationAllowed(
	requireAuthentication = process.env.OCTOCODE_REQUIRE_AUTHENTICATION,
	token = _cachedToken,
): void {
	if (isOctoCodeAuthenticationRequired(requireAuthentication) && !token) {
		throw new Error("OctoCode requires sign-in before an agent task can run.")
	}
}

export async function initOctoCodeAuth(context: vscode.ExtensionContext): Promise<void> {
	if (!context.secrets) {
		// Secret storage unavailable (e.g. test environment without secrets mock).
		// Treat as unauthenticated startup — all cached values remain undefined.
		return
	}
	secretStorage = context.secrets

	// Pre-load the token and user info into memory on init so OctoCodeHandler can access them synchronously
	_cachedToken = await secretStorage.get(OCTOCODE_TOKEN_KEY)
	_sessionCleared = false
	_cachedUserName = await secretStorage.get(OCTOCODE_USER_NAME_KEY)
	_cachedUserEmail = await secretStorage.get(OCTOCODE_USER_EMAIL_KEY)
	_cachedUserImage = await secretStorage.get(OCTOCODE_USER_IMAGE_KEY)

	// Validate persisted auth state on init before reporting the user as connected.
	// Network errors / 5xx ("unreachable") leave the cached session in place so a
	// transient backend blip doesn't force users to sign in again.
	if (_cachedToken) {
		const result = await verifyOctoCodeToken()
		if (result === "invalid") {
			await clearOctoCodeUserInfo()
			await clearOctoCodeToken()
		}
	}

	// Watch for secret changes and update cache
	context.secrets.onDidChange((e) => {
		if (e.key === OCTOCODE_TOKEN_KEY) {
			secretStorage?.get(OCTOCODE_TOKEN_KEY).then((token) => {
				_cachedToken = token
			})
		}
		if (e.key === OCTOCODE_USER_NAME_KEY) {
			secretStorage?.get(OCTOCODE_USER_NAME_KEY).then((name) => {
				_cachedUserName = name
			})
		}
		if (e.key === OCTOCODE_USER_EMAIL_KEY) {
			secretStorage?.get(OCTOCODE_USER_EMAIL_KEY).then((email) => {
				_cachedUserEmail = email
			})
		}
		if (e.key === OCTOCODE_USER_IMAGE_KEY) {
			secretStorage?.get(OCTOCODE_USER_IMAGE_KEY).then((image) => {
				_cachedUserImage = image
			})
		}
	})
}

// Synchronous getter for use in OctoCodeHandler (called in hot path during API requests)
export function getCachedOctoCodeToken(): string {
	return _cachedToken ?? ""
}

/**
 * Resolves the OctoCode Gateway session token for API calls.
 * Secret-storage cache wins over profile-persisted tokens; after an explicit sign-out
 * or 401 clear, profile tokens are ignored so stale credentials cannot be reused.
 */
export function resolveOctoCodeGatewaySessionToken(profileToken?: string): string | undefined {
	if (_cachedToken) {
		return _cachedToken
	}
	if (_sessionCleared) {
		return undefined
	}
	return profileToken || undefined
}

export function getCachedOctoCodeUserInfo(): { name?: string; email?: string; image?: string } {
	return {
		name: _cachedUserName,
		email: _cachedUserEmail,
		image: _cachedUserImage,
	}
}

export async function getOctoCodeToken(): Promise<string | undefined> {
	if (!secretStorage) return undefined
	return secretStorage.get(OCTOCODE_TOKEN_KEY)
}

export async function setOctoCodeToken(token: string): Promise<void> {
	if (!secretStorage) return
	await secretStorage.store(OCTOCODE_TOKEN_KEY, token)
	_cachedToken = token
	_sessionCleared = false
}

export async function setOctoCodeUserInfo(info: {
	name?: string | null
	email?: string | null
	image?: string | null
}): Promise<void> {
	if (!secretStorage) return

	if (info.name) {
		await secretStorage.store(OCTOCODE_USER_NAME_KEY, info.name)
		_cachedUserName = info.name
	} else if (info.name === null) {
		await secretStorage.delete(OCTOCODE_USER_NAME_KEY)
		_cachedUserName = undefined
	}

	if (info.email) {
		await secretStorage.store(OCTOCODE_USER_EMAIL_KEY, info.email)
		_cachedUserEmail = info.email
	} else if (info.email === null) {
		await secretStorage.delete(OCTOCODE_USER_EMAIL_KEY)
		_cachedUserEmail = undefined
	}

	if (info.image) {
		await secretStorage.store(OCTOCODE_USER_IMAGE_KEY, info.image)
		_cachedUserImage = info.image
	} else if (info.image === null) {
		await secretStorage.delete(OCTOCODE_USER_IMAGE_KEY)
		_cachedUserImage = undefined
	}
}

export async function clearOctoCodeUserInfo(): Promise<void> {
	if (!secretStorage) return
	await secretStorage.delete(OCTOCODE_USER_NAME_KEY)
	await secretStorage.delete(OCTOCODE_USER_EMAIL_KEY)
	await secretStorage.delete(OCTOCODE_USER_IMAGE_KEY)
	_cachedUserName = undefined
	_cachedUserEmail = undefined
	_cachedUserImage = undefined
}

export async function clearOctoCodeToken(): Promise<void> {
	if (!secretStorage) return
	await secretStorage.delete(OCTOCODE_TOKEN_KEY)
	_cachedToken = undefined
	_sessionCleared = true
}

export function getOctoCodeBaseUrl(): string {
	return process.env.OCTOCODE_BASE_URL || "https://www.octocode.dev"
}

export async function handleAuthCallback(token: string): Promise<boolean> {
	if (!token || !token.startsWith("octo_ext_")) {
		vscode.window.showErrorMessage(t("common:octoCodeAuth.errors.invalid_token_received"))
		return false
	}

	// Verify token with backend before storing
	const baseUrl = getOctoCodeBaseUrl()
	try {
		const response = await fetch(`${baseUrl}/api/extension/auth/verify`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) {
			// Treat 5xx as a transient backend issue (e.g. DB unreachable) so the
			// user can retry sign-in instead of being told the token is bad.
			if (response.status >= 500) {
				vscode.window.showErrorMessage(t("common:octoCodeAuth.errors.could_not_verify_token"))
			} else {
				vscode.window.showErrorMessage(t("common:octoCodeAuth.errors.token_verification_failed"))
			}
			return false
		}
		const data = (await response.json()) as { valid?: boolean }
		if (!data.valid) {
			vscode.window.showErrorMessage(t("common:octoCodeAuth.errors.invalid_token"))
			return false
		}
	} catch {
		vscode.window.showErrorMessage(t("common:octoCodeAuth.errors.could_not_verify_token"))
		return false
	}

	await setOctoCodeToken(token)

	vscode.window.showInformationMessage(t("common:octoCodeAuth.info.connected"))
	return true
}

/**
 * Verify the stored token against the backend.
 * Returns:
 *   - "valid"       — backend confirmed the token is good
 *   - "invalid"     — backend explicitly rejected the token (4xx or valid: false)
 *   - "unreachable" — network error / timeout / 5xx backend error; token state is unknown
 *
 * 5xx responses are treated as transient: the website returns 503 when the
 * database is unreachable, and clearing a real session on a backend hiccup
 * forces users to sign in again every time the API blips.
 *
 * This function has no side-effects; callers are responsible for acting on the result.
 */
export async function verifyOctoCodeToken(): Promise<"valid" | "invalid" | "unreachable"> {
	const token = await getOctoCodeToken()
	if (!token) return "invalid"

	const baseUrl = getOctoCodeBaseUrl()

	try {
		const response = await fetch(`${baseUrl}/api/extension/auth/verify`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		})

		if (!response.ok) {
			if (response.status >= 500) {
				return "unreachable"
			}
			return "invalid"
		}

		const data = (await response.json()) as { valid?: boolean }
		return data.valid === true ? "valid" : "invalid"
	} catch {
		return "unreachable"
	}
}

export async function isOctoCodeAuthenticated(): Promise<boolean> {
	const token = await getOctoCodeToken()
	return !!token
}

export async function disconnectOctoCode(): Promise<void> {
	const token = await getOctoCodeToken()
	if (token) {
		const baseUrl = getOctoCodeBaseUrl()

		try {
			await fetch(`${baseUrl}/api/extension/auth/revoke`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(10_000),
			})
		} catch {
			// Ignore errors during revocation
		}
	}
	await clearOctoCodeToken()
	await clearOctoCodeUserInfo()
	vscode.window.showInformationMessage(t("common:octoCodeAuth.info.disconnected"))
}
