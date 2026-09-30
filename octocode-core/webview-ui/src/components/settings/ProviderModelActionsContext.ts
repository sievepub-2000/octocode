import { createContext, useContext } from "react"

import type { ProviderModelListSource } from "@roo-code/types"

/**
 * Model-list actions shared by every provider panel rendered inside ApiOptions.
 * `ModelPicker` falls back to these when its own props are not supplied.
 */
export interface ProviderModelActions {
	onFetchModels?: () => void
	onSaveModel?: () => void
	isFetchingModels?: boolean
	disableFetchModels?: boolean
	fetchedModelIds?: string[]
	lastFetchError?: string
	modelListSource?: ProviderModelListSource
	modelListFetchedAt?: number
}

export const ProviderModelActionsContext = createContext<ProviderModelActions>({})

export const useProviderModelActions = () => useContext(ProviderModelActionsContext)
