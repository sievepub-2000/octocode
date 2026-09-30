import { act, fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ChangeEventHandler, InputHTMLAttributes, ReactNode } from "react"
import type { MockInstance } from "vitest"

import { type ModelInfo, type ProviderSettings, anthropicModels, providerIdentifiers } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import ApiOptions, { type ApiOptionsProps } from "../ApiOptions"

type ChildrenProps = { children?: ReactNode }
type VSCodeTextFieldMockProps = ChildrenProps &
	Pick<InputHTMLAttributes<HTMLInputElement>, "value" | "placeholder"> & {
		onInput?: ChangeEventHandler<HTMLInputElement>
	}

const routerInfo: ModelInfo = { contextWindow: 1000, supportsPromptCache: false }

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder }: VSCodeTextFieldMockProps) => (
		<label>
			{children}
			<input value={value ?? ""} placeholder={placeholder} onChange={onInput} />
		</label>
	),
	VSCodeLink: ({ children }: ChildrenProps) => <span>{children}</span>,
	VSCodeButton: ({ children }: ChildrenProps) => <button>{children}</button>,
	VSCodeCheckbox: ({ children }: ChildrenProps) => <label>{children}</label>,
	VSCodeRadio: ({ children }: ChildrenProps) => <label>{children}</label>,
	VSCodeRadioGroup: ({ children }: ChildrenProps) => <div>{children}</div>,
	VSCodeDropdown: ({ children }: ChildrenProps) => <div>{children}</div>,
	VSCodeOption: ({ children }: ChildrenProps) => <div>{children}</div>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
	}),
}))

vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: { openrouter: { "or/model-a": routerInfo } }, refetch: vi.fn() }),
}))

vi.mock("@src/components/ui/hooks/useOctoCodeGatewayRouterModelsSync", () => ({
	useOctoCodeGatewayRouterModelsSync: vi.fn(),
}))

vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	useOpenRouterModelProviders: () => ({ data: undefined }),
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (configuration: ProviderSettings) => ({
		provider: configuration.apiProvider,
		id: configuration.openRouterModelId ?? configuration.apiModelId,
		info: routerInfo,
	}),
}))

vi.mock("../providers/OpenRouterBalanceDisplay", () => ({ OpenRouterBalanceDisplay: () => null }))

Element.prototype.scrollIntoView = vi.fn()

const renderApiOptions = (props: Partial<ApiOptionsProps> = {}) =>
	renderWithExtensionState(
		<ApiOptions
			errorMessage={undefined}
			setErrorMessage={() => undefined}
			uriScheme={undefined}
			apiConfiguration={{}}
			setApiConfigurationField={() => undefined}
			fromWelcomeView
			{...props}
		/>,
	)

const postProviderModels = (values: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "providerModels", values } }))
	})

describe("ApiOptions model list actions", () => {
	let postMessage: MockInstance<typeof vscode.postMessage>

	beforeEach(() => {
		postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it.each([
		{ apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5", apiKey: "k" },
		{ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "or/model-a" },
	] satisfies ProviderSettings[])("shows fetch and save actions for $apiProvider", (apiConfiguration) => {
		const onSaveApiConfiguration = vi.fn()
		renderApiOptions({ apiConfiguration, onSaveApiConfiguration })

		expect(screen.getByTestId("fetch-models-button")).toBeInTheDocument()
		fireEvent.click(screen.getByTestId("save-model-button"))
		expect(onSaveApiConfiguration).toHaveBeenCalledTimes(1)
		expect(screen.getByTestId("save-model-button")).toHaveAttribute("data-state", "saved")

		fireEvent.click(screen.getByTestId("fetch-models-button"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestProviderModels",
			values: { provider: apiConfiguration.apiProvider, apiConfiguration, refresh: true },
		})
	})

	it("asks for the persisted list on mount without refreshing", () => {
		const apiConfiguration: ProviderSettings = { apiProvider: providerIdentifiers.anthropic }
		renderApiOptions({ apiConfiguration })
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestProviderModels",
			values: { provider: providerIdentifiers.anthropic, apiConfiguration, refresh: false },
		})
	})

	it("hides the save action when no save handler is provided", () => {
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" },
		})
		expect(screen.getByTestId("fetch-models-button")).toBeInTheDocument()
		expect(screen.queryByTestId("save-model-button")).not.toBeInTheDocument()
	})

	it("merges fetched ids into the static catalog and reports the result", async () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-sonnet-4-5",
		}
		renderApiOptions({ apiConfiguration })

		fireEvent.click(screen.getByTestId("fetch-models-button"))
		expect(screen.getByTestId("fetch-models-button")).toBeDisabled()

		const knownId = Object.keys(anthropicModels)[0]
		postProviderModels({
			provider: providerIdentifiers.anthropic,
			key: "anthropic|https://api.anthropic.com",
			models: [knownId, "claude-brand-new"],
			source: "remote",
			fetchedAt: Date.now(),
		})

		expect(screen.getByTestId("model-fetch-status")).toHaveTextContent(
			'settings:modelPicker.fetchStatus.fetched {"count":2}',
		)
		expect(screen.getByTestId("fetch-models-button")).not.toBeDisabled()

		await act(async () => {
			fireEvent.click(screen.getByTestId("model-picker-button"))
		})
		expect(await screen.findByTestId("model-option-claude-brand-new")).toBeInTheDocument()
		expect(screen.getByTestId(`model-option-${knownId}`)).toBeInTheDocument()
	})

	it("shows the fetch error from a failed refresh", () => {
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" },
		})
		fireEvent.click(screen.getByTestId("fetch-models-button"))
		postProviderModels({
			provider: providerIdentifiers.anthropic,
			key: "anthropic|https://api.anthropic.com",
			models: [],
			source: "catalog",
			fetchedAt: Date.now(),
			error: "HTTP 401",
		})
		expect(screen.getByTestId("model-fetch-status")).toHaveTextContent(
			'settings:modelPicker.fetchStatus.error {"error":"HTTP 401"}',
		)
	})

	it("ignores replies for other providers", () => {
		renderApiOptions({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-sonnet-4-5" },
		})
		fireEvent.click(screen.getByTestId("fetch-models-button"))
		postProviderModels({
			provider: providerIdentifiers.openrouter,
			key: "openrouter|",
			models: ["x"],
			source: "remote",
			fetchedAt: Date.now(),
		})
		expect(screen.getByTestId("fetch-models-button")).toBeDisabled()
		expect(screen.queryByTestId("model-fetch-status")).not.toBeInTheDocument()
	})
})
