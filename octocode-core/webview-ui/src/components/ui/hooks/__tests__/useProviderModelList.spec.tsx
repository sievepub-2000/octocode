import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { MockInstance } from "vitest"

import type { ExtensionMessage, ProviderSettings, RouterModels } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { useProviderModelList } from "../useProviderModelList"

const dispatch = (data: ExtensionMessage) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

describe("useProviderModelList", () => {
	let postMessage: MockInstance<typeof vscode.postMessage>
	let queryClient: QueryClient

	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	)

	beforeEach(() => {
		postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		queryClient = new QueryClient()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("requests the persisted list on mount and applies the cache reply", () => {
		const config: ProviderSettings = { apiProvider: "anthropic", apiKey: "k" }
		const { result } = renderHook(() => useProviderModelList("anthropic", config), { wrapper })

		expect(postMessage).toHaveBeenCalledWith({
			type: "requestProviderModels",
			values: { provider: "anthropic", apiConfiguration: config, refresh: false },
		})

		dispatch({
			type: "providerModels",
			values: { provider: "anthropic", key: "k", models: ["m1"], source: "cache", fetchedAt: 5 },
		})
		expect(result.current).toMatchObject({ modelIds: ["m1"], source: "cache", fetchedAt: 5, isFetching: false })
	})

	it("tracks a manual fetch and ignores passive replies while it is running", () => {
		const { result } = renderHook(() => useProviderModelList("anthropic", {}), { wrapper })

		act(() => result.current.fetchModels())
		expect(result.current.isFetching).toBe(true)
		expect(postMessage).toHaveBeenLastCalledWith({
			type: "requestProviderModels",
			values: { provider: "anthropic", apiConfiguration: {}, refresh: true },
		})

		dispatch({
			type: "providerModels",
			values: { provider: "anthropic", key: "k", models: ["stale"], source: "catalog", fetchedAt: 0 },
		})
		expect(result.current.isFetching).toBe(true)

		dispatch({
			type: "providerModels",
			values: { provider: "anthropic", key: "k", models: [], source: "catalog", fetchedAt: 9, error: "HTTP 401" },
		})
		expect(result.current).toMatchObject({ isFetching: false, error: "HTTP 401", source: "catalog" })
	})

	it("pushes refreshed router records into the react-query cache", () => {
		const { result } = renderHook(() => useProviderModelList("openrouter", {}), { wrapper })
		act(() => result.current.fetchModels())

		const routerModels: Partial<RouterModels> = {
			openrouter: { "or/new": { contextWindow: 1, supportsPromptCache: false } },
		}
		// Partial single-provider payload, as posted by the extension.
		dispatch({
			type: "routerModels",
			routerModels: routerModels as RouterModels,
			values: { provider: "openrouter" },
		})

		expect(queryClient.getQueryData(["routerModels", "openrouter"])).toEqual(routerModels)
	})

	it("does nothing without a provider", () => {
		const { result } = renderHook(() => useProviderModelList(undefined, {}), { wrapper })
		act(() => result.current.fetchModels())
		expect(postMessage).not.toHaveBeenCalled()
		expect(result.current.isFetching).toBe(false)
	})
})
