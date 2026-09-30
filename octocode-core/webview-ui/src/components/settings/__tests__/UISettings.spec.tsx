import { render, fireEvent, waitFor } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { UISettings } from "../UISettings"
import { telemetryClient } from "@/utils/TelemetryClient"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/utils/TelemetryClient", () => ({
	telemetryClient: { capture: vi.fn() },
}))

describe("UISettings", () => {
	const defaultProps = {
		reasoningBlockCollapsed: false,
		enterBehavior: "send" as const,
		setCachedStateField: vi.fn(),
	}

	it("selects an installed theme inside settings and waits for host confirmation", async () => {
		const { getByTestId, getByRole, queryByTestId } = render(<UISettings {...defaultProps} />)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestColorThemes" })
		expect(queryByTestId("open-color-theme-picker")).toBeNull()
		const themes = [
			{ id: "dark", label: "Dark" },
			{ id: "light", label: "Light" },
		]
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "colorThemeSettings",
					colorThemeSettings: { current: "dark", themes },
				},
			}),
		)
		const select = getByTestId("color-theme-select")
		fireEvent.keyDown(select, { key: "Enter" })
		fireEvent.click(getByRole("option", { name: "Light" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "setColorTheme", text: "light" })
		expect(select).toBeDisabled()
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "colorThemeSettings",
					colorThemeSettings: { current: "dark", themes },
					error: "Cannot save theme",
				},
			}),
		)
		await waitFor(() => expect(getByRole("alert")).toHaveTextContent("Cannot save theme"))
		expect(select).not.toBeDisabled()
		expect(select).toHaveTextContent("Dark")
	})

	it("renders the collapse thinking checkbox", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} />)
		const checkbox = getByTestId("collapse-thinking-checkbox")
		expect(checkbox).toBeTruthy()
	})

	it("displays the correct initial state", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("calls setCachedStateField when checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const checkbox = getByTestId("collapse-thinking-checkbox")
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("reasoningBlockCollapsed", true)
		})
	})

	it("updates checkbox state when prop changes", () => {
		const { getByTestId, rerender } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={false} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)

		rerender(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		expect(checkbox.checked).toBe(true)
	})

	describe("chat font size", () => {
		it("shows the default font size when unset (init)", () => {
			const { getByText, getByTestId } = render(<UISettings {...defaultProps} chatFontSize={undefined} />)
			expect(getByTestId("chat-font-size-slider")).toBeTruthy()
			// Default falls back to VS Code-equivalent default value.
			expect(getByText("13px")).toBeTruthy()
		})

		it("shows the configured font size when set", () => {
			const { getByText } = render(<UISettings {...defaultProps} chatFontSize={20} />)
			expect(getByText("20px")).toBeTruthy()
		})

		it("persists a user-edited font size via setCachedStateField", () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings {...defaultProps} chatFontSize={14} setCachedStateField={setCachedStateField} />,
			)

			const slider = getByTestId("chat-font-size-slider").querySelector('[role="slider"]') as HTMLElement
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(setCachedStateField).toHaveBeenCalledWith("chatFontSize", 15)
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_chat_font_size_changed", { value: 15 })
		})

		it("disables reset when unset and clears the value on reset", () => {
			const setCachedStateField = vi.fn()
			const { getByTestId, rerender } = render(
				<UISettings {...defaultProps} chatFontSize={undefined} setCachedStateField={setCachedStateField} />,
			)

			const resetUnset = getByTestId("chat-font-size-reset") as HTMLButtonElement
			expect(resetUnset.disabled).toBe(true)

			rerender(<UISettings {...defaultProps} chatFontSize={18} setCachedStateField={setCachedStateField} />)
			const resetSet = getByTestId("chat-font-size-reset") as HTMLButtonElement
			expect(resetSet.disabled).toBe(false)

			fireEvent.click(resetSet)
			expect(setCachedStateField).toHaveBeenCalledWith("chatFontSize", undefined)
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_chat_font_size_reset")
		})
	})

	describe("auto-close OctoCode-opened files checkboxes", () => {
		it("renders all three auto-close checkboxes", () => {
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseOctoCodeOpenedFiles={true}
					autoCloseOctoCodeOpenedFilesAfterUserEdited={false}
					autoCloseOctoCodeOpenedNewFiles={false}
				/>,
			)
			expect(getByTestId("auto-close-octocode-opened-files-checkbox")).toBeTruthy()
			expect(getByTestId("auto-close-octocode-opened-files-after-user-edited-checkbox")).toBeTruthy()
			expect(getByTestId("auto-close-octocode-opened-new-files-checkbox")).toBeTruthy()
		})

		it("autoCloseOctoCodeOpenedFiles checkbox reflects true prop", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} autoCloseOctoCodeOpenedFiles={true} />)
			const checkbox = getByTestId("auto-close-octocode-opened-files-checkbox") as HTMLInputElement
			expect(checkbox.checked).toBe(true)
		})

		it("autoCloseOctoCodeOpenedFiles checkbox reflects false prop", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} autoCloseOctoCodeOpenedFiles={false} />)
			const checkbox = getByTestId("auto-close-octocode-opened-files-checkbox") as HTMLInputElement
			expect(checkbox.checked).toBe(false)
		})

		it("autoCloseOctoCodeOpenedFiles checkbox defaults to unchecked when prop is unset", () => {
			// Omitting the prop simulates the opt-in default (false). A regression that
			// flips the fallback back to `?? true` would make this checkbox checked.
			const { getByTestId } = render(<UISettings {...defaultProps} />)
			const checkbox = getByTestId("auto-close-octocode-opened-files-checkbox") as HTMLInputElement
			expect(checkbox.checked).toBe(false)
		})

		it("calls setCachedStateField with autoCloseOctoCodeOpenedFiles when toggled", async () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseOctoCodeOpenedFiles={true}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = getByTestId("auto-close-octocode-opened-files-checkbox")
			fireEvent.click(checkbox)
			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("autoCloseOctoCodeOpenedFiles", false)
			})
		})

		it("calls setCachedStateField with autoCloseOctoCodeOpenedFilesAfterUserEdited when toggled", async () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseOctoCodeOpenedFilesAfterUserEdited={false}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = getByTestId("auto-close-octocode-opened-files-after-user-edited-checkbox")
			fireEvent.click(checkbox)
			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("autoCloseOctoCodeOpenedFilesAfterUserEdited", true)
			})
		})

		it("calls setCachedStateField with autoCloseOctoCodeOpenedNewFiles when toggled", async () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseOctoCodeOpenedNewFiles={false}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = getByTestId("auto-close-octocode-opened-new-files-checkbox")
			fireEvent.click(checkbox)
			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("autoCloseOctoCodeOpenedNewFiles", true)
			})
		})
	})
})
