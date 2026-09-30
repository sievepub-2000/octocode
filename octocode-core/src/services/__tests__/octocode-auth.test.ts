import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import {
	clearOctoCodeToken,
	clearOctoCodeUserInfo,
	disconnectOctoCode,
	getCachedOctoCodeToken,
	getCachedOctoCodeUserInfo,
	getOctoCodeBaseUrl,
	handleAuthCallback,
	initOctoCodeAuth,
	resolveOctoCodeGatewaySessionToken,
	setOctoCodeToken,
	setOctoCodeUserInfo,
	verifyOctoCodeToken,
} from "../octocode-auth"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((key: string, defaultValue?: string) => defaultValue),
		})),
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
}))

vi.mock("../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

const mockFetch = vi.fn()
global.fetch = mockFetch as any

describe("octocode-auth", () => {
	let mockSecrets: any
	let mockContext: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockFetch.mockReset()

		const secretStore: Record<string, string> = {}
		mockSecrets = {
			get: vi.fn(async (key: string) => secretStore[key]),
			store: vi.fn(async (key: string, value: string) => {
				secretStore[key] = value
			}),
			delete: vi.fn(async (key: string) => {
				delete secretStore[key]
			}),
			onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
		}

		mockContext = {
			secrets: mockSecrets,
		}
	})

	afterEach(async () => {
		await clearOctoCodeToken()
		await clearOctoCodeUserInfo()
		vi.restoreAllMocks()
	})

	describe("getCachedOctoCodeToken", () => {
		it("returns an empty string when no token is set", async () => {
			await clearOctoCodeToken()

			expect(getCachedOctoCodeToken()).toBe("")
		})

		it("preloads the cached token during initialization", async () => {
			await mockSecrets.store("octocode-session-token", "octo_ext_cached_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: true }),
			})

			await initOctoCodeAuth(mockContext)
			await Promise.resolve()

			expect(getCachedOctoCodeToken()).toBe("octo_ext_cached_token")
		})
	})

	describe("initOctoCodeAuth", () => {
		it("clears stored user info and token when the cached token is invalid", async () => {
			await mockSecrets.store("octocode-session-token", "octo_ext_stale_token")
			await mockSecrets.store("octocode-user-name", "Jane Doe")
			await mockSecrets.store("octocode-user-email", "jane@example.com")
			await mockSecrets.store("octocode-user-image", "https://example.com/avatar.png")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: false }),
			})

			await initOctoCodeAuth(mockContext)

			// Both token and user info should be cleared on a definitive invalid response
			expect(getCachedOctoCodeToken()).toBe("")
			expect(getCachedOctoCodeUserInfo()).toEqual({
				name: undefined,
				email: undefined,
				image: undefined,
			})
		})

		it("clears stored user info and token when backend returns HTTP error (invalid token)", async () => {
			await mockSecrets.store("octocode-session-token", "octo_ext_stale_token")
			await mockSecrets.store("octocode-user-name", "Jane Doe")
			await mockSecrets.store("octocode-user-email", "jane@example.com")
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			})

			await initOctoCodeAuth(mockContext)

			expect(getCachedOctoCodeToken()).toBe("")
			expect(getCachedOctoCodeUserInfo()).toEqual({
				name: undefined,
				email: undefined,
				image: undefined,
			})
		})

		it("preserves token and user info when the backend is temporarily unreachable", async () => {
			await mockSecrets.store("octocode-session-token", "octo_ext_valid_token")
			await mockSecrets.store("octocode-user-name", "Jane Doe")
			await mockSecrets.store("octocode-user-email", "jane@example.com")
			// Simulate a network error during verification
			mockFetch.mockRejectedValueOnce(new Error("Network error"))

			await initOctoCodeAuth(mockContext)

			expect(getCachedOctoCodeToken()).toBe("octo_ext_valid_token")
			expect(getCachedOctoCodeUserInfo().name).toBe("Jane Doe")
		})

		it("preserves token and user info when verify returns 5xx (transient backend error)", async () => {
			await mockSecrets.store("octocode-session-token", "octo_ext_valid_token")
			await mockSecrets.store("octocode-user-name", "Jane Doe")
			await mockSecrets.store("octocode-user-email", "jane@example.com")
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 503,
				statusText: "Service Unavailable",
			})

			await initOctoCodeAuth(mockContext)

			expect(getCachedOctoCodeToken()).toBe("octo_ext_valid_token")
			expect(getCachedOctoCodeUserInfo().name).toBe("Jane Doe")
		})
	})

	describe("clearOctoCodeToken", () => {
		it("clears the cached token", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_test_token")

			await clearOctoCodeToken()

			expect(getCachedOctoCodeToken()).toBe("")
		})
	})

	describe("getOctoCodeBaseUrl", () => {
		it("returns the default URL when OCTOCODE_BASE_URL is not set", () => {
			const originalEnv = process.env.OCTOCODE_BASE_URL
			delete process.env.OCTOCODE_BASE_URL

			expect(getOctoCodeBaseUrl()).toBe("https://www.octocode.dev")

			if (originalEnv) {
				process.env.OCTOCODE_BASE_URL = originalEnv
			}
		})

		it("respects OCTOCODE_BASE_URL", () => {
			const originalEnv = process.env.OCTOCODE_BASE_URL
			process.env.OCTOCODE_BASE_URL = "https://staging.octocode.dev"

			expect(getOctoCodeBaseUrl()).toBe("https://staging.octocode.dev")

			if (originalEnv) {
				process.env.OCTOCODE_BASE_URL = originalEnv
			} else {
				delete process.env.OCTOCODE_BASE_URL
			}
		})
	})

	describe("handleAuthCallback", () => {
		it("does not persist a token when backend verification fails", async () => {
			await initOctoCodeAuth(mockContext)
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: false }),
			})

			const success = await handleAuthCallback("octo_ext_fake_token")

			expect(success).toBe(false)
			expect(getCachedOctoCodeToken()).toBe("")
			expect(mockSecrets.store).not.toHaveBeenCalledWith("octocode-session-token", "octo_ext_fake_token")
		})

		it("persists a token only after backend verification succeeds", async () => {
			await initOctoCodeAuth(mockContext)
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: true }),
			})

			const success = await handleAuthCallback("octo_ext_real_token")

			expect(success).toBe(true)
			expect(getCachedOctoCodeToken()).toBe("octo_ext_real_token")
			expect(mockSecrets.store).toHaveBeenCalledWith("octocode-session-token", "octo_ext_real_token")
		})
	})

	describe("verifyOctoCodeToken", () => {
		it("returns 'valid' when the backend confirms the token", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_valid_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: true }),
			})

			expect(await verifyOctoCodeToken()).toBe("valid")
			// Token should NOT be cleared — no side effects
			expect(getCachedOctoCodeToken()).toBe("octo_ext_valid_token")
		})

		it("returns 'invalid' when the backend reports valid: false", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_invalid_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: false }),
			})

			expect(await verifyOctoCodeToken()).toBe("invalid")
			// No side effects — caller decides what to do
			expect(getCachedOctoCodeToken()).toBe("octo_ext_invalid_token")
		})

		it("returns 'invalid' when the backend returns 4xx", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_invalid_token")
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			})

			expect(await verifyOctoCodeToken()).toBe("invalid")
		})

		it("returns 'unreachable' when the backend returns 5xx (transient)", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_token")
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 503,
				statusText: "Service Unavailable",
			})

			expect(await verifyOctoCodeToken()).toBe("unreachable")
			expect(getCachedOctoCodeToken()).toBe("octo_ext_token")
		})

		it("returns 'unreachable' when a network error occurs", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_token")
			mockFetch.mockRejectedValueOnce(new Error("Network error"))

			expect(await verifyOctoCodeToken()).toBe("unreachable")
			// Token must NOT be cleared on network error
			expect(getCachedOctoCodeToken()).toBe("octo_ext_token")
		})

		it("returns 'invalid' when no token is stored", async () => {
			await initOctoCodeAuth(mockContext)

			expect(await verifyOctoCodeToken()).toBe("invalid")
		})
	})

	describe("setOctoCodeUserInfo", () => {
		it("clears email when passed null", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeUserInfo({
				name: "Jane Doe",
				email: "jane@example.com",
				image: "https://example.com/avatar.png",
			})

			// Verify email is set
			expect(getCachedOctoCodeUserInfo().email).toBe("jane@example.com")

			// Clear email with null
			await setOctoCodeUserInfo({ email: null })

			// Email should be cleared, but other fields should remain
			const info = getCachedOctoCodeUserInfo()
			expect(info.email).toBeUndefined()
			expect(info.name).toBe("Jane Doe")
			expect(info.image).toBe("https://example.com/avatar.png")
		})

		it("does not clear email when passed undefined", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeUserInfo({
				name: "Jane Doe",
				email: "jane@example.com",
				image: "https://example.com/avatar.png",
			})

			// Pass undefined for email - should preserve existing value
			await setOctoCodeUserInfo({ name: "John Doe", email: undefined })

			const info = getCachedOctoCodeUserInfo()
			expect(info.email).toBe("jane@example.com")
			expect(info.name).toBe("John Doe")
		})
	})

	describe("resolveOctoCodeGatewaySessionToken", () => {
		it("prefers the cached token over a profile token", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_cached")

			expect(resolveOctoCodeGatewaySessionToken("octo_ext_profile")).toBe("octo_ext_cached")
		})

		it("ignores profile tokens after an explicit sign-out clear", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_cached")
			await clearOctoCodeToken()

			expect(resolveOctoCodeGatewaySessionToken("octo_ext_stale_profile")).toBeUndefined()
		})

		it("falls back to the profile token when the cache is empty and not cleared", async () => {
			await initOctoCodeAuth(mockContext)

			expect(resolveOctoCodeGatewaySessionToken("octo_ext_profile")).toBe("octo_ext_profile")
		})
	})

	describe("disconnectOctoCode", () => {
		it("revokes the current token and clears cached auth state", async () => {
			await initOctoCodeAuth(mockContext)
			await setOctoCodeToken("octo_ext_real_token")
			await setOctoCodeUserInfo({
				name: "Jane Doe",
				email: "jane@example.com",
				image: "https://example.com/avatar.png",
			})
			mockFetch.mockResolvedValueOnce({ ok: true })

			await disconnectOctoCode()

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/api/extension/auth/revoke"),
				expect.objectContaining({
					method: "POST",
					headers: { Authorization: "Bearer octo_ext_real_token" },
				}),
			)
			expect(getCachedOctoCodeToken()).toBe("")
			expect(getCachedOctoCodeUserInfo()).toEqual({
				name: undefined,
				email: undefined,
				image: undefined,
			})
		})
	})
})
