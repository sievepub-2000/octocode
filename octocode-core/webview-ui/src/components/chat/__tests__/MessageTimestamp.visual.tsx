import React from "react"
import { expect, test } from "../../../../playwright/coverage-fixture"
import MessageTimestamp from "../MessageTimestamp"

test("local message time stays centered above content at narrow and wide widths", async ({ mount, page }) => {
	for (const width of [320, 800]) {
		await page.setViewportSize({ width, height: 320 })
		const component = await mount(
			<div style={{ padding: 16 }}>
				<MessageTimestamp timestamp={new Date(2026, 9, 18, 12, 59, 7).getTime()} />
				<p>Agent thinking, execution, or answer</p>
			</div>,
		)
		const time = component.locator("time")
		await expect(time).toHaveText("--2026-10-18 12:59:07--")
		await expect(time).toHaveCSS("text-align", "center")
		const box = await time.boundingBox()
		expect(box).not.toBeNull()
		expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(1)
		await test.info().attach(`message-time-${width}`, {
			body: await component.screenshot({ path: test.info().outputPath(`message-time-${width}.png`) }),
			contentType: "image/png",
		})
		await component.unmount()
	}
})
