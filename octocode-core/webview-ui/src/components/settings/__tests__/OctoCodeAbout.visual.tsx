import React from "react"
import { expect, test } from "../../../../playwright/coverage-fixture"
import { TooltipProvider } from "@/components/ui/tooltip"
import { OctoCodeAbout } from "../OctoCodeAbout"

test("About exposes complete local documentation without network access", async ({ mount, page }) => {
	await page.route("https://**/*", (route) => route.abort())
	await page.route("http://**/*", (route) => {
		return new URL(route.request().url()).hostname === "localhost" ? route.continue() : route.abort()
	})
	const component = await mount(
		<TooltipProvider>
			<OctoCodeAbout />
		</TooltipProvider>,
	)
	await expect(component.getByText("此项目由 zillafan80@gmail.com 独立完成。", { exact: true })).toBeVisible()
	for (const title of ["完整授权协议（离线）", "第三方许可与来源全文（离线）", "使用手册（离线）"]) {
		const summary = component.locator("summary", { hasText: title })
		await summary.click()
		await expect(summary.locator("..")).toHaveAttribute("open", "")
		await expect(summary.locator("..").locator('[data-testid="about-document"]')).toBeVisible()
		await summary.click()
	}
	await page.screenshot({ path: "test-results/about-offline-2.0.4.png", fullPage: true })
	await component.locator("summary", { hasText: "使用手册（离线）" }).click()
	await expect(component.getByRole("heading", { name: "13. 授权与合作" })).toBeVisible()
	await page.screenshot({ path: "test-results/about-manual-2.0.4.png", fullPage: true })
})
