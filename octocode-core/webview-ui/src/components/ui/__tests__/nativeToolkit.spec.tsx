import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.unmock("@vscode/webview-ui-toolkit/react")

import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

describe("native VS Code text field", () => {
	it("renders labels and adornments outside the void input element", () => {
		render(
			<VSCodeTextField aria-label="搜索">
				<label>名称</label>
				<span slot="start">图标</span>
			</VSCodeTextField>,
		)

		const input = screen.getByRole("textbox", { name: "搜索" })
		expect(input).toBeInTheDocument()
		expect(input.parentElement).toHaveClass("octo-vscode-input-wrap")
		expect(screen.getByText("名称")).toHaveAttribute("for", input.id)
		expect(screen.getByText("图标")).toBeInTheDocument()
	})
})
