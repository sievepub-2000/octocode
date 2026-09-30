import { act, fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ReactNode } from "react"

import { type ModelInfo, providerIdentifiers } from "@roo-code/types"

import { ModelPicker } from "../ModelPicker"
import { type ProviderModelActions, ProviderModelActionsContext } from "../ProviderModelActionsContext"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
	}),
}))

const info: ModelInfo = { contextWindow: 1000, supportsPromptCache: false }

const baseProps = {
	apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model1" },
	defaultModelId: "model1",
	modelIdKey: "openRouterModelId" as const,
	serviceName: "Test Service",
	serviceUrl: "https://test.service",
	models: { model1: info },
	setApiConfigurationField: vi.fn(),
	organizationAllowList: { allowAll: true, providers: {} },
}

const withActions = (value: ProviderModelActions, children: ReactNode) => (
	<ProviderModelActionsContext.Provider value={value}>{children}</ProviderModelActionsContext.Provider>
)

describe("ModelPicker model list actions", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("renders no actions without props or context", () => {
		renderWithExtensionState(<ModelPicker {...baseProps} />)
		expect(screen.queryByTestId("fetch-models-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("save-model-button")).not.toBeInTheDocument()
	})

	it("falls back to context actions and status", () => {
		const onFetchModels = vi.fn()
		const onSaveModel = vi.fn()
		renderWithExtensionState(
			withActions(
				{
					onFetchModels,
					onSaveModel,
					fetchedModelIds: ["a", "b", "c"],
					modelListSource: "remote",
					modelListFetchedAt: 1,
				},
				<ModelPicker {...baseProps} />,
			),
		)

		fireEvent.click(screen.getByTestId("fetch-models-button"))
		fireEvent.click(screen.getByTestId("save-model-button"))
		expect(onFetchModels).toHaveBeenCalledTimes(1)
		expect(onSaveModel).toHaveBeenCalledTimes(1)
		expect(screen.getByTestId("model-fetch-status")).toHaveTextContent(
			'settings:modelPicker.fetchStatus.fetched {"count":3}',
		)
	})

	it("shows a cache status with the fetch time", () => {
		renderWithExtensionState(
			withActions(
				{ onFetchModels: vi.fn(), fetchedModelIds: ["a"], modelListSource: "cache", modelListFetchedAt: 42 },
				<ModelPicker {...baseProps} />,
			),
		)
		expect(screen.getByTestId("model-fetch-status")).toHaveTextContent("settings:modelPicker.fetchStatus.cached")
	})

	it("disables the context fetch action while fetching", () => {
		renderWithExtensionState(
			withActions({ onFetchModels: vi.fn(), isFetchingModels: true }, <ModelPicker {...baseProps} />),
		)
		expect(screen.getByTestId("fetch-models-button")).toBeDisabled()
		expect(screen.queryByTestId("model-fetch-status")).not.toBeInTheDocument()
	})

	it("lets explicit props win over context values", () => {
		const contextFetch = vi.fn()
		const contextSave = vi.fn()
		const explicitFetch = vi.fn()
		const explicitSave = vi.fn()
		renderWithExtensionState(
			withActions(
				{
					onFetchModels: contextFetch,
					onSaveModel: contextSave,
					isFetchingModels: true,
					lastFetchError: "context error",
				},
				<ModelPicker {...baseProps} onFetchModels={explicitFetch} onSaveModel={explicitSave} />,
			),
		)

		const fetchButton = screen.getByTestId("fetch-models-button")
		expect(fetchButton).not.toBeDisabled()
		fireEvent.click(fetchButton)
		fireEvent.click(screen.getByTestId("save-model-button"))
		expect(explicitFetch).toHaveBeenCalledTimes(1)
		expect(explicitSave).toHaveBeenCalledTimes(1)
		expect(contextFetch).not.toHaveBeenCalled()
		expect(contextSave).not.toHaveBeenCalled()
		// Context status belongs to the context fetch action, not an explicit one.
		expect(screen.queryByTestId("model-fetch-status")).not.toBeInTheDocument()
	})

	it("shows a transient saved state after saving", () => {
		vi.useFakeTimers()
		renderWithExtensionState(withActions({ onSaveModel: vi.fn() }, <ModelPicker {...baseProps} />))

		const saveButton = screen.getByTestId("save-model-button")
		expect(saveButton).toHaveTextContent("settings:modelPicker.saveModel")
		fireEvent.click(saveButton)
		expect(saveButton).toHaveTextContent("settings:modelPicker.saved")

		act(() => {
			vi.advanceTimersByTime(2000)
		})
		expect(saveButton).toHaveTextContent("settings:modelPicker.saveModel")
	})
})
