import { memo } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import { Trans } from "react-i18next"
import TranslationProvider from "../TranslationContext"
import i18next, { loadLocale } from "../setup"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ language: "zh-CN" }) }))

const RichText = memo(() => (
	<div data-testid="rich-text">
		<Trans i18nKey="chat:about" />
		<Trans i18nKey="chat:docs" components={{ DocsLink: <a href="https://example.com" /> }} />
	</div>
))

it("updates memoized rich text and links when switching languages", async () => {
	await loadLocale("zh-CN")
	await i18next.changeLanguage("zh-CN")
	await act(async () => {
		render(
			<TranslationProvider>
				<RichText />
			</TranslationProvider>,
		)
	})
	await waitFor(() => expect(screen.getByTestId("rich-text")).toHaveTextContent("本地 AI"))
	await act(async () => {
		await i18next.changeLanguage("en")
	})
	expect(i18next.language).toBe("en")
	expect(screen.getByTestId("rich-text")).toHaveTextContent("local AI agent workspace")
	expect(screen.getByTestId("rich-text").textContent).not.toMatch(/[\u4e00-\u9fff]/)
	expect(screen.getByRole("link")).toHaveTextContent("docs")
	await act(async () => {
		await i18next.changeLanguage("zh-CN")
	})
	expect(screen.getByTestId("rich-text")).toHaveTextContent("本地 AI")
})
