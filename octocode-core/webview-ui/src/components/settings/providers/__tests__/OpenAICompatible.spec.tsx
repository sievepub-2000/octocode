import React from "react"
import { act } from "@testing-library/react"
import { useEvent } from "react-use"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { OpenAICompatible } from "../OpenAICompatible"
import { ProviderSettings } from "@roo-code/types"

// Mock the vscrui Checkbox component
vi.mock("@/components/ui/settings-checkbox", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label data-testid={`checkbox-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onChange(!checked)} // Toggle the checked state
				data-testid={`checkbox-input-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}
			/>
			{children}
		</label>
	),
}))

// Mock the VSCodeTextField and VSCodeButton components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		children,
		value,
		onInput,
		placeholder,
		className,
		style,
		"data-testid": dataTestId,
		...rest
	}: any) => {
		return (
			<div
				data-testid={dataTestId ? `${dataTestId}-text-field` : "vscode-text-field"}
				className={className}
				style={style}>
				{children}
				<input
					type="text"
					value={value}
					onChange={(e) => onInput && onInput(e)}
					placeholder={placeholder}
					data-testid={dataTestId}
					{...rest}
				/>
			</div>
		)
	},
	VSCodeButton: ({ children, onClick, appearance, title }: any) => (
		<button onClick={onClick} title={title} data-testid={`vscode-button-${appearance}`}>
			{children}
		</button>
	),
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock the UI components
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	// Vendor-preset picker. Rendered as a native select so tests can drive it
	// without pulling in the real popover/command stack.
	SearchableSelect: ({ value, onValueChange, options, placeholder, ...rest }: any) => (
		<select
			data-testid={rest["data-testid"]}
			aria-label={placeholder}
			value={value ?? ""}
			onChange={(e) => onValueChange(e.target.value)}>
			<option value="">{placeholder}</option>
			{(options ?? []).map((o: any) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	),
}))

// Mock other components
const { mockModelPicker } = vi.hoisted(() => ({ mockModelPicker: vi.fn() }))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: any) => {
		mockModelPicker(props)
		return <div data-testid="model-picker">Model Picker</div>
	},
}))

vi.mock("../../R1FormatSetting", () => ({
	R1FormatSetting: () => <div data-testid="r1-format-setting">R1 Format Setting</div>,
}))

const { mockThinkingBudget } = vi.hoisted(() => ({ mockThinkingBudget: vi.fn() }))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: (props: any) => {
		mockThinkingBudget(props)
		return <div data-testid="thinking-budget">Thinking Budget</div>
	},
}))

// Mock react-use
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

describe("OpenAICompatible Component - includeMaxTokens checkbox", () => {
	const mockSetApiConfigurationField = vi.fn()
	const mockOrganizationAllowList = {
		allowAll: true,
		providers: {},
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("Checkbox Rendering", () => {
		it("should render the includeMaxTokens checkbox", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the checkbox is rendered
			const checkbox = screen.getByTestId("checkbox-settings:includemaxoutputtokens")
			expect(checkbox).toBeInTheDocument()

			// Check that the description text is rendered
			expect(screen.getByText("settings:includeMaxOutputTokensDescription")).toBeInTheDocument()
		})

		it("should render the checkbox with correct translation keys", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the correct translation key is used for the label
			expect(screen.getByText("settings:includeMaxOutputTokens")).toBeInTheDocument()

			// Check that the correct translation key is used for the description
			expect(screen.getByText("settings:includeMaxOutputTokensDescription")).toBeInTheDocument()
		})
	})

	describe("Azure OpenAI guidance", () => {
		it.each([
			{ openAiBaseUrl: "https://resource.openai.azure.com/" },
			{ openAiBaseUrl: "https://models.example.com", openAiUseAzure: true },
		])("shows Azure-specific endpoint and deployment guidance", (apiConfiguration) => {
			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(screen.getByPlaceholderText("settings:providers.azureOpenAiBaseUrlPlaceholder")).toBeInTheDocument()
			expect(mockModelPicker).toHaveBeenLastCalledWith(
				expect.objectContaining({ label: "settings:providers.azureOpenAiDeploymentName" }),
			)
			expect(screen.getByText("settings:providers.azureOpenAiDeploymentNameDescription")).toBeInTheDocument()
		})

		it("keeps generic OpenAI-compatible guidance for non-Azure endpoints", () => {
			render(
				<OpenAICompatible
					apiConfiguration={{ openAiBaseUrl: "https://models.example.com/v1" } as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toBeInTheDocument()
			expect(mockModelPicker).toHaveBeenLastCalledWith(expect.objectContaining({ label: undefined }))
			expect(
				screen.queryByText("settings:providers.azureOpenAiDeploymentNameDescription"),
			).not.toBeInTheDocument()
		})

		it("keeps generic OpenAI-compatible guidance for Azure AI Inference endpoints", () => {
			render(
				<OpenAICompatible
					apiConfiguration={
						{ openAiBaseUrl: "https://my-resource.services.ai.azure.com/models" } as ProviderSettings
					}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(mockModelPicker).toHaveBeenLastCalledWith(expect.objectContaining({ label: undefined }))
			expect(
				screen.queryByText("settings:providers.azureOpenAiDeploymentNameDescription"),
			).not.toBeInTheDocument()
		})

		it("keeps generic guidance when Azure AI Inference uses the Azure compatibility flag", () => {
			render(
				<OpenAICompatible
					apiConfiguration={
						{
							openAiBaseUrl: "https://my-resource.services.ai.azure.com/models",
							openAiUseAzure: true,
						} as ProviderSettings
					}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toBeInTheDocument()
			expect(mockModelPicker).toHaveBeenLastCalledWith(expect.objectContaining({ label: undefined }))
		})
	})

	describe("Initial State", () => {
		it("should show checkbox as checked when includeMaxTokens is true", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})

		it("should show checkbox as unchecked when includeMaxTokens is false", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).not.toBeChecked()
		})

		it("should default to checked when includeMaxTokens is undefined", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				// includeMaxTokens is not defined
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})

		it("should default to checked when includeMaxTokens is null", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: null as any,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()
		})
	})

	describe("User Interaction", () => {
		it("should call handleInputChange with correct parameters when checkbox is clicked from checked to unchecked", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			fireEvent.click(checkboxInput)

			// Verify setApiConfigurationField was called with correct parameters
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("includeMaxTokens", false)
		})

		it("should call handleInputChange with correct parameters when checkbox is clicked from unchecked to checked", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			fireEvent.click(checkboxInput)

			// Verify setApiConfigurationField was called with correct parameters
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("includeMaxTokens", true)
		})
	})

	describe("Component Updates", () => {
		it("should update checkbox state when apiConfiguration changes", () => {
			const apiConfigurationInitial: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			const { rerender } = render(
				<OpenAICompatible
					apiConfiguration={apiConfigurationInitial as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Verify initial state
			let checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).toBeChecked()

			// Update with new configuration
			const apiConfigurationUpdated: Partial<ProviderSettings> = {
				includeMaxTokens: false,
			}

			rerender(
				<OpenAICompatible
					apiConfiguration={apiConfigurationUpdated as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Verify updated state
			checkboxInput = screen.getByTestId("checkbox-input-settings:includemaxoutputtokens")
			expect(checkboxInput).not.toBeChecked()
		})
	})

	describe("UI Structure", () => {
		it("should render the checkbox with description in correct structure", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				includeMaxTokens: true,
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			// Check that the checkbox and description are in a div container
			const checkbox = screen.getByTestId("checkbox-settings:includemaxoutputtokens")
			const parentDiv = checkbox.closest("div")
			expect(parentDiv).toBeInTheDocument()

			// Check that the description has the correct styling classes
			const description = screen.getByText("settings:includeMaxOutputTokensDescription")
			expect(description).toHaveClass("text-sm", "text-vscode-descriptionForeground", "ml-6")
		})
	})
	describe("reasoning effort", () => {
		it("should expose and persist the max reasoning-effort value", () => {
			const apiConfiguration: Partial<ProviderSettings> = {
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
				},
			}

			render(
				<OpenAICompatible
					apiConfiguration={apiConfiguration as ProviderSettings}
					setApiConfigurationField={mockSetApiConfigurationField}
					organizationAllowList={mockOrganizationAllowList}
				/>,
			)

			const thinkingBudgetProps = mockThinkingBudget.mock.calls[0][0]
			expect(thinkingBudgetProps.modelInfo.supportsReasoningEffort).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			])

			thinkingBudgetProps.setApiConfigurationField("reasoningEffort", "max")

			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiCustomModelInfo", {
				...apiConfiguration.openAiCustomModelInfo,
				reasoningEffort: "max",
			})
		})
	})
})

describe("OpenAICompatible Component - vendor presets", () => {
	const mockSetApiConfigurationField = vi.fn()
	const mockOrganizationAllowList = { allowAll: true, providers: {} }

	beforeEach(() => {
		vi.clearAllMocks()
	})

	const renderWith = (apiConfiguration: Partial<ProviderSettings>) =>
		render(
			<OpenAICompatible
				apiConfiguration={apiConfiguration as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={mockOrganizationAllowList}
			/>,
		)

	it("offers presets across local, china, international and aggregator groups", () => {
		renderWith({})
		const select = screen.getByTestId("openai-compatible-preset-select") as HTMLSelectElement
		const values = Array.from(select.options).map((o) => o.value)

		// A representative from each group must be reachable.
		expect(values).toContain("vllm")
		expect(values).toContain("siliconflow")
		expect(values).toContain("groq")
		expect(values).toContain("openrouter")
	})

	it("writes the vendor base URL when a preset is chosen", () => {
		renderWith({})
		fireEvent.change(screen.getByTestId("openai-compatible-preset-select"), { target: { value: "groq" } })

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiBaseUrl", "https://api.groq.com/openai/v1")
	})

	it("preselects the preset matching an already-configured base URL", () => {
		// Trailing slash must still match — users paste URLs both ways.
		renderWith({ openAiBaseUrl: "https://api.siliconflow.cn/v1/" })
		const select = screen.getByTestId("openai-compatible-preset-select") as HTMLSelectElement
		expect(select.value).toBe("siliconflow")
	})

	it("leaves the preset unselected for a base URL that matches no vendor", () => {
		renderWith({ openAiBaseUrl: "https://my-private-gateway.internal/v1" })
		const select = screen.getByTestId("openai-compatible-preset-select") as HTMLSelectElement
		expect(select.value).toBe("")
	})

	it("does not clobber a configured base URL merely by rendering", () => {
		renderWith({ openAiBaseUrl: "http://192.168.10.2:8000/v1" })
		expect(mockSetApiConfigurationField).not.toHaveBeenCalledWith("openAiBaseUrl", expect.anything())
	})
})

it("applies fetched model context to the selected model and to later selections", () => {
	const setField = vi.fn()
	render(
		<OpenAICompatible
			apiConfiguration={{ openAiModelId: "qwen38" } as ProviderSettings}
			setApiConfigurationField={setField}
			organizationAllowList={{ allowAll: true, providers: {} }}
		/>,
	)
	const onMessage = vi
		.mocked(useEvent)
		.mock.calls.filter((call) => call[0] === "message")
		.at(-1)?.[1] as ((event: MessageEvent) => void) | undefined
	expect(onMessage).toBeDefined()
	act(() =>
		onMessage!(
			new MessageEvent("message", {
				data: {
					type: "openAiModels",
					openAiModels: ["qwen38", "fallback"],
					openAiModelInfo: {
						qwen38: { contextWindow: 262144 },
						fallback: { contextWindow: 128000 },
					},
				},
			}),
		),
	)
	expect(setField).toHaveBeenCalledWith("openAiCustomModelInfo", { contextWindow: 262144 }, false)
	expect(mockModelPicker.mock.lastCall?.[0].models.qwen38.contextWindow).toBe(262144)
	act(() => mockModelPicker.mock.lastCall?.[0].onModelChange("fallback"))
	expect(setField).toHaveBeenCalledWith("openAiCustomModelInfo", { contextWindow: 128000 })
})
