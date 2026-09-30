import { render, screen } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"

import { LanguageSettings } from "../LanguageSettings"

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => (key === "settings:language.installPack" ? "Install JSON language pack" : key),
		languagePacks: [{ schemaVersion: 1, locale: "fr-CA", name: "Français (Canada)", resources: {} }],
	}),
}))

describe("LanguageSettings", () => {
	it("opens the native whole-application display language picker", async () => {
		render(<LanguageSettings language="en" />)
		await userEvent.click(screen.getByTestId("display-language-picker"))
		expect(postMessage).toHaveBeenCalledWith({ type: "openDisplayLanguagePicker" })
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
	})

	it("installs packs through the extension host", async () => {
		render(<LanguageSettings language="en" />)
		await userEvent.click(screen.getByText("common:ui.supplementalTranslations"))
		await userEvent.click(screen.getByRole("button", { name: "Install JSON language pack" }))
		expect(postMessage).toHaveBeenCalledWith({ type: "installLanguagePack" })
	})
	it("removes a supplemental pack through the extension host", async () => {
		render(<LanguageSettings language="en" />)
		await userEvent.click(screen.getByText("common:ui.supplementalTranslations"))
		await userEvent.click(screen.getByRole("button", { name: "common:answers.remove" }))
		expect(postMessage).toHaveBeenCalledWith({ type: "removeLanguagePack", text: "fr-CA" })
	})
})
