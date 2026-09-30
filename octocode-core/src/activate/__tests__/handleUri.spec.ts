vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
	},
}))

import * as vscode from "vscode"

const {
	mockGetVisibleInstance,
	mockGetAllInstances,
	mockHandleOctoCodeAuthCallback,
	mockSetOctoCodeUserInfo,
	mockVisibleProvider,
} = vi.hoisted(() => {
	const mockVisibleProvider = {
		handleOpenRouterCallback: vi.fn(),
		handleRequestyCallback: vi.fn(),
		handleOctoCodeCallback: vi.fn(),
	} as any

	return {
		mockGetVisibleInstance: vi.fn(() => mockVisibleProvider),
		mockGetAllInstances: vi.fn(() => [mockVisibleProvider]),
		mockHandleOctoCodeAuthCallback: vi.fn(),
		mockSetOctoCodeUserInfo: vi.fn(),
		mockVisibleProvider,
	}
})

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: {
		getVisibleInstance: mockGetVisibleInstance,
		getAllInstances: mockGetAllInstances,
	},
}))

vi.mock("../../services/octocode-auth", () => ({
	handleAuthCallback: mockHandleOctoCodeAuthCallback,
	setOctoCodeUserInfo: mockSetOctoCodeUserInfo,
}))

import { handleUri } from "../handleUri"

describe("handleUri", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetVisibleInstance.mockReturnValue(mockVisibleProvider)
		mockGetAllInstances.mockReturnValue([mockVisibleProvider])
	})

	it("ignores legacy cloud auth callback", async () => {
		await handleUri({
			path: "/auth/clerk/callback",
			query: "code=test-code&state=test-state&organizationId=test-org",
		} as any)

		expect(mockVisibleProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleRequestyCallback).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Roo Code Cloud sign-in is currently unavailable. Configure another provider to continue.",
		)
	})

	it("stores callback user info even when no provider instances exist", async () => {
		mockGetVisibleInstance.mockReturnValue(null)
		mockGetAllInstances.mockReturnValue([])
		mockHandleOctoCodeAuthCallback.mockResolvedValue(true)

		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token&name=Jane%20Doe&email=jane%40example.com&image=https%3A%2F%2Fexample.com%2Favatar.png",
		} as any)

		expect(mockHandleOctoCodeAuthCallback).toHaveBeenCalledWith("octo_ext_test_token")
		expect(mockSetOctoCodeUserInfo).toHaveBeenCalledWith({
			name: "Jane Doe",
			email: "jane@example.com",
			image: "https://example.com/avatar.png",
		})
		// No provider instances exist, so handleOctoCodeCallback should not be called
		expect(mockVisibleProvider.handleOctoCodeCallback).not.toHaveBeenCalled()
	})

	it("refreshes the visible provider after a successful auth callback", async () => {
		mockHandleOctoCodeAuthCallback.mockResolvedValue(true)

		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token",
		} as any)

		// When no user info is provided, null values are passed to clear stale data
		expect(mockSetOctoCodeUserInfo).toHaveBeenCalledWith({
			name: null,
			email: null,
			image: null,
		})
		expect(mockVisibleProvider.handleOctoCodeCallback).toHaveBeenCalledWith("octo_ext_test_token")
	})

	it("clears stale user info fields when re-authing with missing fields", async () => {
		mockHandleOctoCodeAuthCallback.mockResolvedValue(true)

		// Re-auth with only name - email and image should be cleared
		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token&name=John%20Doe",
		} as any)

		expect(mockSetOctoCodeUserInfo).toHaveBeenCalledWith({
			name: "John Doe",
			email: null,
			image: null,
		})
	})

	it("does not persist user info when auth callback validation fails", async () => {
		mockHandleOctoCodeAuthCallback.mockResolvedValue(false)

		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token&name=Jane%20Doe",
		} as any)

		expect(mockSetOctoCodeUserInfo).not.toHaveBeenCalled()
		expect(mockVisibleProvider.handleOctoCodeCallback).not.toHaveBeenCalled()
	})

	it("propagates the callback token to every ClineProvider instance, not just the visible one", async () => {
		// Regression: prior to multi-instance fan-out, hidden providers (sidebar collapsed,
		// secondary panels) never received the octoCodeSessionToken, so their profile settings
		// stayed unauthenticated until reload.
		mockHandleOctoCodeAuthCallback.mockResolvedValue(true)

		const hiddenProvider = { handleOctoCodeCallback: vi.fn() } as any
		const secondHidden = { handleOctoCodeCallback: vi.fn() } as any
		mockGetAllInstances.mockReturnValue([mockVisibleProvider, hiddenProvider, secondHidden])

		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token",
		} as any)

		expect(mockHandleOctoCodeAuthCallback).toHaveBeenCalledWith("octo_ext_test_token")
		expect(mockSetOctoCodeUserInfo).toHaveBeenCalled()
		expect(mockVisibleProvider.handleOctoCodeCallback).toHaveBeenCalledWith("octo_ext_test_token")
		expect(hiddenProvider.handleOctoCodeCallback).toHaveBeenCalledWith("octo_ext_test_token")
		expect(secondHidden.handleOctoCodeCallback).toHaveBeenCalledWith("octo_ext_test_token")
	})

	it("serializes callbacks across instances to avoid concurrent profile-store writes", async () => {
		// Regression: a previous implementation used Promise.all which fanned out concurrent
		// read-modify-write operations on the same provider settings store. Verify the
		// callbacks are invoked sequentially.
		mockHandleOctoCodeAuthCallback.mockResolvedValue(true)

		const order: string[] = []
		const makeProvider = (name: string) =>
			({
				handleOctoCodeCallback: vi.fn(async () => {
					order.push(`${name}:start`)
					// Yield to the event loop so a concurrent call would interleave.
					await new Promise((resolve) => setTimeout(resolve, 0))
					order.push(`${name}:end`)
				}),
			}) as any

		const a = makeProvider("a")
		const b = makeProvider("b")
		mockGetAllInstances.mockReturnValue([a, b])

		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token",
		} as any)

		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
	})

	it("continues fan-out when one instance fails to persist the callback token", async () => {
		mockHandleOctoCodeAuthCallback.mockResolvedValue(true)

		const failingProvider = {
			handleOctoCodeCallback: vi.fn(async () => {
				throw new Error("profile store unavailable")
			}),
		} as any
		const healthyProvider = { handleOctoCodeCallback: vi.fn() } as any
		mockGetAllInstances.mockReturnValue([failingProvider, healthyProvider])

		await handleUri({
			path: "/auth-callback",
			query: "token=octo_ext_test_token",
		} as any)

		expect(failingProvider.handleOctoCodeCallback).toHaveBeenCalledWith("octo_ext_test_token")
		expect(healthyProvider.handleOctoCodeCallback).toHaveBeenCalledWith("octo_ext_test_token")
	})
})
