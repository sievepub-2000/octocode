import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({}))

import { SecretStorageService, StoredMcpOAuthData } from "../SecretStorageService"

function createMockContext() {
	const store = new Map<string, string>()
	// Listeners registered via onDidChange; keyed by arbitrary id for disposal.
	const listeners = new Map<number, (e: { key: string }) => void>()
	let nextId = 0

	const secrets = {
		get: vi.fn(async (key: string) => store.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
		onDidChange: vi.fn((handler: (e: { key: string }) => void) => {
			const id = nextId++
			listeners.set(id, handler)
			return { dispose: () => listeners.delete(id) }
		}),
		/** Test helper: simulate a storage change event. */
		_emit: (key: string) => {
			for (const handler of listeners.values()) handler({ key })
		},
	}

	return { secrets } as any
}

describe("SecretStorageService", () => {
	let service: SecretStorageService
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		context = createMockContext()
		service = new SecretStorageService(context)
	})

	describe("getOAuthData", () => {
		it("should return undefined when no data stored", async () => {
			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toBeUndefined()
		})

		it("should return stored data", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toEqual(data)
		})

		it("should return undefined for malformed JSON", async () => {
			await service.getOAuthData("https://example.com/mcp")
			const key = context.secrets.get.mock.calls[0][0]
			await context.secrets.store(key, "not-json")

			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toBeUndefined()
		})
	})

	describe("saveOAuthData", () => {
		it("should persist data under an opaque resource-specific key", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "abc", token_type: "Bearer" },
				expires_at: 12345,
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			expect(context.secrets.store).toHaveBeenCalledWith(
				expect.stringMatching(/^mcp\.oauth\.v2\.[0-9a-f]{64}\.data$/),
				JSON.stringify(data),
			)
		})

		it("should handle root path correctly", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "abc", token_type: "Bearer" },
				expires_at: 12345,
			}
			await service.saveOAuthData("https://example.com/", data)

			expect(context.secrets.store).toHaveBeenCalledWith(
				expect.stringMatching(/^mcp\.oauth\.v2\.[0-9a-f]{64}\.data$/),
				JSON.stringify(data),
			)
		})
	})

	describe("hasOAuthData", () => {
		it("should return false when no data stored", async () => {
			expect(await service.hasOAuthData("https://example.com/mcp")).toBe(false)
		})

		it("should return true when data is stored", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)
			expect(await service.hasOAuthData("https://example.com/mcp")).toBe(true)
		})

		it("should return false after data is deleted", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)
			await service.deleteOAuthData("https://example.com/mcp")
			expect(await service.hasOAuthData("https://example.com/mcp")).toBe(false)
		})
	})

	describe("deleteOAuthData", () => {
		it("should delete stored data", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
			}
			await service.saveOAuthData("https://example.com/mcp", data)
			const key = context.secrets.store.mock.calls[0][0]

			await service.deleteOAuthData("https://example.com/mcp")

			expect(context.secrets.delete).toHaveBeenCalledWith(key)
			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toBeUndefined()
		})
	})

	describe("onDidChange", () => {
		it("should call the callback when the key for the given URL changes", async () => {
			const cb = vi.fn()
			service.onDidChange("https://example.com/mcp", cb)

			await service.getOAuthData("https://example.com/mcp")
			context.secrets._emit(context.secrets.get.mock.calls[0][0])

			expect(cb).toHaveBeenCalledTimes(1)
		})

		it("should not call the callback for a different URL's key", () => {
			const cb = vi.fn()
			service.onDidChange("https://example.com/mcp", cb)

			context.secrets._emit("mcp.oauth.other.com.L21jcA.data")

			expect(cb).not.toHaveBeenCalled()
		})

		it("should stop calling the callback after the returned dispose function is called", async () => {
			const cb = vi.fn()
			const unsubscribe = service.onDidChange("https://example.com/mcp", cb)

			unsubscribe()
			await service.getOAuthData("https://example.com/mcp")
			context.secrets._emit(context.secrets.get.mock.calls[0][0])

			expect(cb).not.toHaveBeenCalled()
		})
	})

	describe("client_info round-trip", () => {
		it("should persist and retrieve full client_info", async () => {
			const data: StoredMcpOAuthData = {
				tokens: { access_token: "tok", token_type: "Bearer" },
				expires_at: Date.now() + 3600_000,
				client_info: {
					client_id: "cid-123",
					client_secret: "secret-456",
					client_name: "Test Client",
					redirect_uris: ["http://localhost:12345/callback"],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "client_secret_post",
				},
			}
			await service.saveOAuthData("https://example.com/mcp", data)

			const result = await service.getOAuthData("https://example.com/mcp")
			expect(result).toEqual(data)
			expect(result?.client_info?.client_id).toBe("cid-123")
			expect(result?.client_info?.client_secret).toBe("secret-456")
			expect(result?.client_info?.token_endpoint_auth_method).toBe("client_secret_post")
		})
	})

	describe("key isolation", () => {
		it("isolates schemes and query-scoped resources on the same host and path", async () => {
			const urls = ["http://example.com/mcp", "https://example.com/mcp", "https://example.com/mcp?tenant=a"]
			for (const [index, url] of urls.entries()) {
				await service.saveOAuthData(url, {
					tokens: { access_token: `owned-${index}`, token_type: "Bearer" },
					expires_at: index,
				})
			}
			for (const [index, url] of urls.entries()) {
				expect((await service.getOAuthData(url))?.tokens.access_token).toBe(`owned-${index}`)
			}
		})

		it("preserves an unbound legacy record without returning it as current credentials", async () => {
			const key = "mcp.oauth.example.com.L21jcA.data"
			const raw = JSON.stringify({
				tokens: { access_token: "owned-legacy", token_type: "Bearer" },
				expires_at: 12345,
			})
			await context.secrets.store(key, raw)
			expect(await service.getOAuthData("https://example.com/mcp")).toBeUndefined()
			expect(await context.secrets.get(key)).toBe(raw)
			expect(context.secrets.delete).not.toHaveBeenCalled()
		})

		it("should isolate data by host", async () => {
			const data1: StoredMcpOAuthData = {
				tokens: { access_token: "a", token_type: "Bearer" },
				expires_at: 1,
			}
			const data2: StoredMcpOAuthData = {
				tokens: { access_token: "b", token_type: "Bearer" },
				expires_at: 2,
			}
			await service.saveOAuthData("https://host1.com/mcp", data1)
			await service.saveOAuthData("https://host2.com/mcp", data2)

			expect((await service.getOAuthData("https://host1.com/mcp"))?.tokens.access_token).toBe("a")
			expect((await service.getOAuthData("https://host2.com/mcp"))?.tokens.access_token).toBe("b")
		})

		it("should isolate data by path on the same host", async () => {
			const data1: StoredMcpOAuthData = {
				tokens: { access_token: "path1", token_type: "Bearer" },
				expires_at: 1,
			}
			const data2: StoredMcpOAuthData = {
				tokens: { access_token: "path2", token_type: "Bearer" },
				expires_at: 2,
			}
			await service.saveOAuthData("https://example.com/service1", data1)
			await service.saveOAuthData("https://example.com/service2", data2)

			expect((await service.getOAuthData("https://example.com/service1"))?.tokens.access_token).toBe("path1")
			expect((await service.getOAuthData("https://example.com/service2"))?.tokens.access_token).toBe("path2")
		})

		it("should not collide between paths that differ only in separators (/a-b, /a_b, /a/b)", async () => {
			const urls = ["https://example.com/a-b", "https://example.com/a_b", "https://example.com/a/b"]
			for (const [i, url] of urls.entries()) {
				await service.saveOAuthData(url, {
					tokens: { access_token: `tok-${i}`, token_type: "Bearer" },
					expires_at: i,
				})
			}

			for (const [i, url] of urls.entries()) {
				expect((await service.getOAuthData(url))?.tokens.access_token).toBe(`tok-${i}`)
			}
		})
	})
})
