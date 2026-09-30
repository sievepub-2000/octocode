import { useCallback, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { type ExtensionMessage, type RouterModels, providerIdentifiers } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import { fetchRouterModels } from "./useRouterModels"

/**
 * Keeps octocode-gateway models in the shared routerModels query fresh when credentials
 * become available (sign-in or profile seeding) without coupling auth to modelCache.
 */
export function useOctoCodeGatewayRouterModelsSync() {
	const queryClient = useQueryClient()
	const { octoCodeIsAuthenticated } = useExtensionState()
	const wasAuthenticatedRef = useRef<boolean | undefined>(undefined)

	const syncOctoCodeGatewayModels = useCallback(async () => {
		if (!octoCodeIsAuthenticated) {
			return
		}

		try {
			const partial = await fetchRouterModels(providerIdentifiers.octoCodeGateway)
			const zooModels = partial[providerIdentifiers.octoCodeGateway]
			if (!zooModels || Object.keys(zooModels).length === 0) {
				return
			}

			queryClient.setQueryData<RouterModels>(["routerModels", "all"], (current) =>
				current ? { ...current, [providerIdentifiers.octoCodeGateway]: zooModels } : partial,
			)
		} catch {
			// Ignore: bulk router fetch may still be in flight.
		}
	}, [queryClient, octoCodeIsAuthenticated])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = event.data as ExtensionMessage
			if (message.type === "octoCodeGatewayCredentialsReady") {
				void syncOctoCodeGatewayModels()
			}
		}

		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [syncOctoCodeGatewayModels])

	useEffect(() => {
		const wasAuthenticated = wasAuthenticatedRef.current
		wasAuthenticatedRef.current = octoCodeIsAuthenticated

		if (octoCodeIsAuthenticated && wasAuthenticated === false) {
			void syncOctoCodeGatewayModels()
		}
	}, [octoCodeIsAuthenticated, syncOctoCodeGatewayModels])
}
