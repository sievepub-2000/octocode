import React from "react"
import { expect, test } from "../../../../playwright/coverage-fixture"

for (const theme of ["light", "dark"]) {
	test(`brand fills stay red in ${theme} theme`, async ({ mount, page }) => {
		const component = await mount(
			<div className={`vscode-${theme}`} style={{ background: "var(--vscode-editor-background)", padding: 20 }}>
				<textarea data-testid="composer" className="border outline octocode-brand-outline" />
				<div style={{ display: "flex", gap: 16 }}>
					{["AD", "Mode", "Recording", "Stop"].map((name) => (
						<button
							key={name}
							className="octocode-brand-fill bg-transparent opacity-90 hover:bg-primary rounded p-2">
							{name}
						</button>
					))}
					<button className="bg-transparent" data-testid="unfilled">
						Attach
					</button>
					<button disabled className="bg-transparent opacity-40" data-testid="disabled-send">
						Send
					</button>
				</div>
			</div>,
		)
		await expect(component.getByTestId("composer")).toHaveCSS("border-top-color", "rgb(212, 85, 79)")
		await component.getByTestId("composer").focus()
		await expect(component.getByTestId("composer")).toHaveCSS("outline-color", "rgb(212, 85, 79)")
		await expect(component.getByTestId("disabled-send")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
		await expect(component.getByTestId("disabled-send")).toHaveCSS("opacity", "0.4")
		for (const button of await component.locator(".octocode-brand-fill:not(:disabled)").all()) {
			await expect(button).toHaveCSS("background-color", "rgb(212, 85, 79)")
			await expect(button).toHaveCSS("opacity", "1")
			await button.hover()
			await expect(button).toHaveCSS("background-color", "rgb(212, 85, 79)")
			await page.mouse.down()
			await expect(button).toHaveCSS("background-color", "rgb(212, 85, 79)")
			await page.mouse.up()
		}
		await expect(component.getByTestId("unfilled")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
		// Capture diagnostics without generating host-specific golden baselines.
		await test.info().attach(`brand-controls-${theme}`, {
			body: await component.screenshot(),
			contentType: "image/png",
		})
	})
}
