import { useCallback, useContext, useEffect, useRef, useState } from "react"
import { QueryClientContext } from "@tanstack/react-query"

import {
	type ExtensionMessage,
	type ProviderModelListSource,
	type ProviderModelsResponseValues,
	type ProviderName,
	type ProviderSettings,
	isDynamicProvider,
	isLocalProvider,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

export interface ProviderModelListState {
	modelIds: string[]
	source?: ProviderModelListSource
	fetchedAt?: number
	error?: string
	isFetching: boolean
	fetchModels: (refresh?: boolean) => void
}

type ListSnapshot = Pick<ProviderModelListState, "modelIds" | "source" | "fetchedAt" | "error">

const EMPTY: ListSnapshot = { modelIds: [] }

const isResponseFor = (
	message: ExtensionMessage,
	provider: ProviderName,
): message is ExtensionMessage & {
	values: ProviderModelsResponseValues
} => message.type === "providerModels" && message.values?.provider === provider

/**
 * Manual model-list refresh for any provider. Auto-fetching stays in ApiOptions and
 * `useRouterModels`; this hook only serves the explicit "Fetch model list" action and
 * the persisted result of the last one.
 */
export function useProviderModelList(
	provider: ProviderName | undefined,
	apiConfiguration: ProviderSettings,
	options: { enabled?: boolean } = {},
): ProviderModelListState {
	const enabled = options.enabled !== false && Boolean(provider)
	const queryClient = useContext(QueryClientContext)
	const [snapshot, setSnapshot] = useState<ListSnapshot>(EMPTY)
	const [isFetching, setIsFetching] = useState(false)

	const configRef = useRef(apiConfiguration)
	const fetchingRef = useRef(false)

	useEffect(() => {
		configRef.current = apiConfiguration
	}, [apiConfiguration])

	const post = useCallback(
		(refresh: boolean) => {
			if (!provider) return
			vscode.postMessage({
				type: "requestProviderModels",
				values: { provider, apiConfiguration: configRef.current, refresh },
			})
		},
		[provider],
	)

	// Reset and ask for the persisted list whenever the provider changes.
	useEffect(() => {
		setSnapshot(EMPTY)
		setIsFetching(false)
		fetchingRef.current = false
		if (enabled) {
			post(false)
		}
	}, [enabled, post])

	useEffect(() => {
		if (!enabled || !provider) return

		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (!message || typeof message !== "object") return

			// A manual fetch for a router/local provider also posts its full records;
			// push them into the react-query cache read by the provider's own picker.
			if (
				message.type === "routerModels" &&
				fetchingRef.current &&
				message.values?.provider === provider &&
				message.routerModels &&
				(isDynamicProvider(provider) || isLocalProvider(provider))
			) {
				queryClient?.setQueryData(["routerModels", provider], message.routerModels)
				return
			}

			if (!isResponseFor(message, provider)) return

			const { models, source, fetchedAt, error } = message.values
			// Cache/catalog replies to the mount request (fetchedAt 0) must not end a manual fetch.
			const isPassiveReply = source === "cache" || !fetchedAt
			if (fetchingRef.current && isPassiveReply) return

			fetchingRef.current = false
			setIsFetching(false)
			setSnapshot({ modelIds: Array.isArray(models) ? models : [], source, fetchedAt, error })
		}

		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [enabled, provider, queryClient])

	const fetchModels = useCallback(
		(refresh = true) => {
			if (!enabled) return
			fetchingRef.current = true
			setIsFetching(true)
			post(refresh)
		},
		[enabled, post],
	)

	return { ...snapshot, isFetching, fetchModels }
}
