import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

// Mock the SDK's discoverOAuthProtectedResourceMetadata
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	discoverOAuthProtectedResourceMetadata: vi.fn(),
}))

import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js"
import { fetchOAuthAuthServerMetadata } from "../oauth"

const mockFetch = vi.fn()
const originalFetch = global.fetch
global.fetch = mockFetch

describe("fetchOAuthAuthServerMetadata", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterAll(() => {
		global.fetch = originalFetch
	})

	it("returns null when resource metadata has no authorization_servers", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: [],
		})

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("rejects a non-loopback HTTP authorization server before fetching metadata", async () => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
			resource: "https://example.com/mcp",
			authorization_servers: ["http://auth.example.com"],
		})
		expect(await fetchOAuthAuthServerMetadata("https://example.com/mcp")).toBeNull()
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("permits an HTTP loopback authorization server for local development", async () => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
			resource: "https://example.com/mcp",
			authorization_servers: ["http://127.0.0.1:8765"],
		})
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ issuer: "http://127.0.0.1:8765", token_endpoint: "http://127.0.0.1:8765/token" }),
		})
		expect(await fetchOAuthAuthServerMetadata("http://127.0.0.1:8765/mcp")).not.toBeNull()
	})

	it("returns null when discoverOAuthProtectedResourceMetadata throws", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockRejectedValue(new Error("network error"))

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("constructs the RFC 8414 discovery URL correctly for an issuer with a path", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://mcp.kapa.ai/",
			authorization_servers: ["https://mcp.kapa.ai/auth/public"],
		})

		const mockMeta = {
			issuer: "https://mcp.kapa.ai/auth/public",
			registration_endpoint: "https://mcp.kapa.ai/auth/public/register",
		}
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockMeta) })

		const result = await fetchOAuthAuthServerMetadata("https://mcp.kapa.ai/mcp")

		// Verify the RFC 8414 §3.1 URL: well-known inserted between host and path
		expect(mockFetch).toHaveBeenCalledWith(
			"https://mcp.kapa.ai/.well-known/oauth-authorization-server/auth/public",
			expect.objectContaining({ headers: { Accept: "application/json" }, redirect: "error" }),
		)
		expect(result).toEqual({ authServerMeta: mockMeta, resourceIndicator: "https://mcp.kapa.ai/" })
	})

	it("constructs the RFC 8414 discovery URL correctly for an issuer without a path", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://auth.example.com/",
			authorization_servers: ["https://auth.example.com"],
		})

		const mockMeta = { issuer: "https://auth.example.com" }
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockMeta) })

		await fetchOAuthAuthServerMetadata("https://auth.example.com/mcp")

		expect(mockFetch).toHaveBeenCalledWith(
			"https://auth.example.com/.well-known/oauth-authorization-server",
			expect.any(Object),
		)
	})

	it("strips trailing slash from issuer path before inserting well-known", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://example.com/issuer/"],
		})

		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

		await fetchOAuthAuthServerMetadata("https://example.com/mcp")

		expect(mockFetch).toHaveBeenCalledWith(
			"https://example.com/.well-known/oauth-authorization-server/issuer",
			expect.any(Object),
		)
	})

	it("returns null when the discovery endpoint returns a non-OK response", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://auth.example.com"],
		})

		mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("returns null when fetch throws", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://auth.example.com"],
		})

		mockFetch.mockRejectedValueOnce(new Error("connection refused"))

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toBeNull()
	})

	it("returns the parsed metadata and resource indicator on success", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			resource: "https://example.com/",
			authorization_servers: ["https://auth.example.com/oauth2"],
		})

		const meta = {
			issuer: "https://auth.example.com/oauth2",
			authorization_endpoint: "https://auth.example.com/oauth2/authorize",
			token_endpoint: "https://auth.example.com/oauth2/token",
			registration_endpoint: "https://auth.example.com/oauth2/register",
			token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			scopes_supported: ["openid"],
		}
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(meta) })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toEqual({ authServerMeta: meta, resourceIndicator: "https://example.com/" })
	})

	it.each(["authorization_endpoint", "token_endpoint", "registration_endpoint"])(
		"rejects an insecure %s in authorization metadata",
		async (endpoint) => {
			vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
				resource: "https://example.com/mcp",
				authorization_servers: ["https://auth.example.com"],
			})
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issuer: "https://auth.example.com",
					[endpoint]: "http://collector.example.com/endpoint",
				}),
			})
			expect(await fetchOAuthAuthServerMetadata("https://example.com/mcp")).toBeNull()
		},
	)

	it("accepts a secure token endpoint on another origin", async () => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
			resource: "https://example.com/mcp",
			authorization_servers: ["https://auth.example.com"],
		})
		const meta = { issuer: "https://auth.example.com", token_endpoint: "https://tokens.example.net/token" }
		mockFetch.mockResolvedValueOnce({ ok: true, json: async () => meta })
		expect((await fetchOAuthAuthServerMetadata("https://example.com/mcp"))?.authServerMeta).toEqual(meta)
	})

	it("rejects a loopback HTTP token endpoint advertised by a remote issuer", async () => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
			resource: "https://example.com/mcp",
			authorization_servers: ["https://auth.example.com"],
		})
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ issuer: "https://auth.example.com", token_endpoint: "http://127.0.0.1:8765/token" }),
		})
		expect(await fetchOAuthAuthServerMetadata("https://example.com/mcp")).toBeNull()
	})

	it("returns null resourceIndicator when protected resource metadata has no resource field", async () => {
		;(discoverOAuthProtectedResourceMetadata as any).mockResolvedValue({
			authorization_servers: ["https://auth.example.com"],
			// no `resource` field
		})

		const meta = { issuer: "https://auth.example.com" }
		mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(meta) })

		const result = await fetchOAuthAuthServerMetadata("https://example.com/mcp")
		expect(result).toEqual({ authServerMeta: meta, resourceIndicator: null })
	})

	it("rejects metadata that names a different issuer than the discovery server", async () => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
			resource: "https://example.com/mcp",
			authorization_servers: ["https://other.example/issuer"],
		})
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ issuer: "https://auth.example.com/issuer" }),
		})
		expect(await fetchOAuthAuthServerMetadata("https://example.com/mcp")).toBeNull()
	})

	it("does not use missing issuer metadata as a credential binding", async () => {
		vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
			resource: "https://example.com/mcp",
			authorization_servers: ["https://auth.example.com"],
		})
		mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
		expect(await fetchOAuthAuthServerMetadata("https://example.com/mcp")).toBeNull()
	})

	it("clears its discovery deadline after a successful response", async () => {
		vi.useFakeTimers()
		try {
			vi.mocked(discoverOAuthProtectedResourceMetadata).mockResolvedValue({
				resource: "https://example.com/mcp",
				authorization_servers: ["https://auth.example.com"],
			})
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ issuer: "https://auth.example.com" }) })
			expect(await fetchOAuthAuthServerMetadata("https://example.com/mcp")).not.toBeNull()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})
