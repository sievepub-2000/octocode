import { expect, test } from "../../../../playwright/coverage-fixture"
import ShellLayoutFixture from "./ShellLayout.visual.fixture"

// Local Windows verification can use the installed Edge without changing CI's browser.
if (process.env.OCTOCODE_CT_CHANNEL === "msedge") test.use({ channel: "msedge" })

for (const theme of ["dark", "high-contrast-light", "high-contrast"] as const)
	for (const width of [1200, 700, 390]) {
		test(`${theme} shell footer keeps settings next to account at ${width}px`, async ({
			mount,
			page,
		}, testInfo) => {
			await page.setViewportSize({ width, height: 820 })
			const component = await mount(<ShellLayoutFixture theme={theme} />)
			await expect(component.locator(".octo-shell")).toHaveCSS(
				"background-color",
				theme === "dark"
					? "rgb(0, 0, 0)"
					: theme === "high-contrast"
						? "rgb(28, 26, 43)"
						: "rgb(255, 255, 255)",
			)
			const footer = component.locator(".octo-rail-group--footer")
			const settings = footer.getByRole("button", { name: "Settings", exact: true })
			const account = footer.locator('button[title="Account"]')
			await expect(settings).toBeVisible()
			await expect(account).toBeVisible()
			const emptyUpdate = footer.locator(".octo-rail-cell:has(> .octo-rail-slot:empty)")
			await expect(emptyUpdate).toHaveCount(1)
			await expect(emptyUpdate).toBeHidden()
			const positions = await footer.locator(".octo-rail-cell").evaluateAll((cells) =>
				cells
					.filter((cell) => getComputedStyle(cell).display !== "none")
					.map((cell) => {
						const box = cell.getBoundingClientRect()
						return { top: box.top, bottom: box.bottom }
					}),
			)
			expect(positions).toHaveLength(2)
			expect(positions[1].top - positions[0].bottom).toBe(6)
			await page.screenshot({ path: testInfo.outputPath("shell-no-update.png"), fullPage: true })

			await component.update(<ShellLayoutFixture available theme={theme} />)
			const update = footer.locator(".octo-rail-item--update")
			await expect(update).toBeVisible()
			const labels = await footer
				.getByRole("button")
				.evaluateAll((buttons) =>
					buttons.map((button) =>
						button.classList.contains("octo-rail-item--update") ? "update" : button.getAttribute("title"),
					),
				)
			expect(labels).toEqual(["update", "Settings", "Account"])
			await page.screenshot({ path: testInfo.outputPath("shell-update-available.png"), fullPage: true })
		})
	}
