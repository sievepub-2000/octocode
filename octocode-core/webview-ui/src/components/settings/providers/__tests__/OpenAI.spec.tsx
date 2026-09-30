import React from "react"

import { OpenAiServiceTier, providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { OpenAI } from "../OpenAI"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) =>
			({
				"settings:serviceTier.standard": "Standard",
				"settings:serviceTier.flex": "Flex",
				"settings:serviceTier.priority": "Priority",
			})[key] ?? key,
	}),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, ...props }: any) => (
		<button onClick={onClick} data-testid={props["data-testid"]}>
			{children}
		</button>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<select aria-label="Service tier" value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
	StandardTooltip: ({ children, content }: any) => <span title={content}>{children}</span>,
}))

const baseModelInfo: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: true,
}

describe("OpenAI service tier selector", () => {
	it("shows supported service tiers and persists the selected tier", () => {
		const setApiConfigurationField = vi.fn()
		const selectedModelInfo: ModelInfo = {
			...baseModelInfo,
			tiers: [
				{ name: OpenAiServiceTier.Default, contextWindow: 128_000 },
				{ contextWindow: 128_000 },
				{ name: OpenAiServiceTier.Flex, contextWindow: 128_000 },
				{ name: OpenAiServiceTier.Priority, contextWindow: 128_000 },
			],
		}
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.openaiNative,
			openAiNativeApiKey: "test-api-key",
		}

		render(
			<OpenAI
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={selectedModelInfo}
			/>,
		)

		const selector = screen.getByRole("combobox", { name: "Service tier" })
		expect(selector).toHaveValue(OpenAiServiceTier.Default)
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
			"Standard",
			"Flex",
			"Priority",
		])

		fireEvent.change(selector, { target: { value: OpenAiServiceTier.Flex } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiNativeServiceTier", OpenAiServiceTier.Flex)

		fireEvent.change(selector, { target: { value: OpenAiServiceTier.Priority } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiNativeServiceTier", OpenAiServiceTier.Priority)
	})

	it("hides the selector when the model only exposes the default tier", () => {
		render(
			<OpenAI
				apiConfiguration={{
					apiProvider: providerIdentifiers.openaiNative,
					openAiNativeApiKey: "test-api-key",
				}}
				setApiConfigurationField={vi.fn()}
				selectedModelInfo={{
					...baseModelInfo,
					tiers: [{ name: OpenAiServiceTier.Default, contextWindow: 128_000 }],
				}}
			/>,
		)

		expect(screen.queryByTestId("openai-service-tier")).not.toBeInTheDocument()
	})
})

describe("OpenAI official entry with a non-OpenAI base URL", () => {
	it("offers to move a local endpoint to OpenAI Compatible without losing its values", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<OpenAI
				apiConfiguration={{
					apiProvider: providerIdentifiers.openaiNative,
					apiModelId: "qwen38-flash-next:instruct",
					openAiNativeApiKey: "qwen38",
					openAiNativeBaseUrl: " http://2.2.2.2:8000/v1 ",
				}}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("openai-native-non-official-url")).toBeInTheDocument()
		fireEvent.click(screen.getByTestId("switch-to-openai-compatible"))

		expect(setApiConfigurationField).toHaveBeenCalledWith("apiProvider", providerIdentifiers.openai)
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiBaseUrl", "http://2.2.2.2:8000/v1")
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiApiKey", "qwen38")
		expect(setApiConfigurationField).toHaveBeenCalledWith("openAiModelId", "qwen38-flash-next:instruct")
	})

	it("shows no warning for the official endpoint", () => {
		render(
			<OpenAI
				apiConfiguration={{
					apiProvider: providerIdentifiers.openaiNative,
					openAiNativeBaseUrl: "https://api.openai.com/v1",
				}}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.queryByTestId("openai-native-non-official-url")).not.toBeInTheDocument()
	})
})
