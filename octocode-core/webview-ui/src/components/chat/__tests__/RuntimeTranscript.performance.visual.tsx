import React from "react"
import { performance } from "node:perf_hooks"
import { expect, test } from "@playwright/experimental-ct-react"
import type { RuntimeEvent } from "../../artifacts/runtimeEvent"
import TranscriptPerformanceHarness from "./TranscriptPerformanceHarness"

const eventsFor = (count: number): RuntimeEvent[] =>
	Array.from({ length: count }, (_, index) => ({
		task_id: "performance-task",
		session_id: "performance-session",
		kind: index % 3 === 0 ? "text" : index % 3 === 1 ? "thought" : "tool_call",
		payload: {
			data:
				index % 3 === 0
					? `Answer ${index}: verified source and preserved behavior.\n\n- Keep the timestamp\n- Retain attachments\n\n\`\`\`typescript\nconst row = ${index};\n\`\`\``
					: `Step ${index}: inspect the current source and report the result.`,
		},
		created_at: 1_792_295_940_000 + index * 1_000,
	}))

test("large transcript renders and updates without losing scroll position or input focus", async ({ mount, page }) => {
	test.setTimeout(180_000)
	page.on("pageerror", (error) => console.error("BROWSER_ERROR " + error.stack))
	await page.setViewportSize({ width: 700, height: 800 })
	const props = { prompt: "performance fixture", running: true, phase: "thinking" as const, onSelectOption: () => {} }
	const commits: number[] = []
	const view = (events: RuntimeEvent[]) => (
		<TranscriptPerformanceHarness
			{...props}
			events={events}
			onRender={(_id, _phase, duration) => commits.push(duration)}
		/>
	)

	// Warm the real component and its Markdown module before measuring the history size.
	const warm = await mount(view(eventsFor(3)))
	await expect(warm.getByText("performance fixture")).toBeVisible()
	await warm.unmount()
	const events = eventsFor(1_200)
	const started = performance.now()
	const component = await mount(view(events))
	const scroller = component.locator('[data-virtuoso-scroller="true"]').first()
	await expect(scroller).toBeVisible()
	await expect(scroller.locator("time").first()).toBeAttached()
	await expect.poll(() => scroller.evaluate((element) => element.scrollHeight)).toBeGreaterThan(5_000)
	await expect(scroller.getByText("Step 1199: inspect the current source and report the result.")).toBeVisible()
	await page.waitForTimeout(100)
	const mountMs = performance.now() - started
	const mounted = await scroller.evaluate((element) => ({
		nodes: element.querySelectorAll("*").length,
		timestamps: element.querySelectorAll("time").length,
		height: element.scrollHeight,
	}))
	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight / 2
		element.dispatchEvent(new Event("scroll"))
	})
	await page.waitForTimeout(300)
	const before = await scroller.evaluate((element) => element.scrollTop)
	const visibleAnchor = () =>
		scroller.evaluate((element) => {
			const top = element.getBoundingClientRect().top
			for (const item of element.querySelectorAll<HTMLElement>("[data-item-index]")) {
				const bounds = item.getBoundingClientRect()
				if (bounds.bottom > top + 10) return { index: item.dataset.itemIndex, top: bounds.top - top }
			}
			return undefined
		})
	const anchorBefore = await visibleAnchor()
	const input = component.getByRole("textbox", { name: "Performance input" })
	await input.focus()
	const priorCommits = commits.length
	const updateStart = performance.now()
	for (let index = 0; index < 8; index++) {
		await component.update(
			view([...events, ...eventsFor(index + 1).map((event) => ({ ...event, task_id: "stream-tail" }))]),
		)
	}
	const updateMs = (performance.now() - updateStart) / 8
	const inputStart = performance.now()
	await input.pressSequentially("typing stays responsive", { delay: 1 })
	const inputMs = performance.now() - inputStart
	await expect(input).toBeFocused()
	await expect(input).toHaveValue("typing stays responsive")
	const after = await scroller.evaluate((element) => element.scrollTop)
	const anchorAfter = await visibleAnchor()
	const metrics = {
		rows: events.length,
		mountMs,
		meanUpdateMs: updateMs,
		inputMs,
		mountedNodes: mounted.nodes,
		mountedTimestamps: mounted.timestamps,
		scrollHeight: mounted.height,
		scrollShift: after - before,
		anchorBefore,
		anchorAfter,
		updateReactCommitMs: commits.slice(priorCommits),
	}
	console.log("TRANSCRIPT_PERFORMANCE " + JSON.stringify(metrics))
	await test.info().attach("metrics", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" })
	await test.info().attach("transcript", { body: await page.screenshot(), contentType: "image/png" })
	if (anchorBefore) {
		expect(anchorAfter?.index).toBe(anchorBefore.index)
		expect(Math.abs((anchorAfter?.top ?? Infinity) - anchorBefore.top)).toBeLessThan(4)
	} else expect(Math.abs(after - before)).toBeLessThan(100)
	expect(mounted.timestamps).toBeLessThan(150)
	await component.unmount()
})

test("virtual history preserves earlier-page reading, attachments, options and live tail", async ({ mount, page }) => {
	const image =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
	let selected = ""
	const view = (events: RuntimeEvent[]) => (
		<TranscriptPerformanceHarness
			prompt="Initial image prompt"
			images={[image]}
			events={events}
			running
			phase="thinking"
			onSelectOption={(answer) => {
				selected = answer
			}}
			withInput={false}
			height={700}
		/>
	)

	let events: RuntimeEvent[] = Array.from({ length: 150 }, (_, index) => ({
		session_id: "history",
		task_id: `turn-${index}`,
		kind: "thought",
		payload: { data: `History row ${index}.` },
		created_at: 1_792_295_940_000 + index * 1_000,
	}))
	const component = await mount(view(events))
	const scroller = component.locator('[data-virtuoso-scroller="true"]').first()
	await expect(component.getByText("History row 149.")).toBeVisible()
	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight / 2
		element.dispatchEvent(new Event("scroll"))
	})
	await page.waitForTimeout(200)
	const reading = () =>
		scroller.evaluate((element) => {
			const top = element.getBoundingClientRect().top
			return [...element.querySelectorAll("p")].find((item) => item.getBoundingClientRect().bottom > top + 10)
				?.textContent
		})
	const before = await reading()
	expect(before).toMatch(/History row/)
	const earlier = Array.from({ length: 3 }, (_, index) => ({
		...events[0],
		task_id: `earlier-${index}`,
		payload: { data: `Earlier history ${index}.` },
		created_at: 1_792_295_930_000 + index * 1_000,
	}))
	events = [...earlier, ...events]
	await component.update(view(events))
	await expect.poll(reading).toBe(before)
	await scroller.evaluate((element) => {
		element.scrollTop = 0
	})
	await expect(component.getByText("Initial image prompt")).toBeVisible()
	await expect(component.getByRole("img")).toHaveAttribute("src", image)
	await expect
		.poll(() => component.getByRole("img").evaluate((element: HTMLImageElement) => element.naturalWidth))
		.toBe(1)
	await expect(component.getByText("Earlier history 0.")).toBeVisible()
	const question: RuntimeEvent = {
		...events[0],
		task_id: "question",
		kind: "agent.needs_input",
		payload: { question: "Choose the next step", options: ["Continue", "Pause"] },
	}
	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight
		element.dispatchEvent(new Event("scroll"))
	})
	await component.update(view([...events, question]))
	await expect(component.getByText("Choose the next step")).toBeVisible()
	await component.getByRole("button", { name: "Continue", exact: true }).click()
	await expect.poll(() => selected).toBe("Continue")
	const ownTurn: RuntimeEvent = {
		...question,
		kind: "user.message",
		payload: { text: "User image follow-up", images: [image] },
	}
	await component.update(view([...events, question, ownTurn]))
	await expect(component.getByText("User image follow-up")).toBeVisible()
	await expect(component.getByRole("img")).toHaveCount(2)
	await expect
		.poll(() =>
			component
				.getByRole("img")
				.last()
				.evaluate((element: HTMLImageElement) => element.naturalWidth),
		)
		.toBe(1)
	const answer: RuntimeEvent = {
		...question,
		kind: "text",
		payload: { data: "New live answer" },
		created_at: 1_792_296_900_000,
	}
	await component.update(view([...events, question, ownTurn, answer]))
	await expect(component.getByText("New live answer")).toBeVisible()
	await expect(component.locator('time[datetime="2026-10-18T04:15:00.000Z"]')).toBeVisible()
	await component.unmount()
})

test("crossing the virtualization threshold preserves an earlier reading position", async ({ mount, page }) => {
	const view = (events: RuntimeEvent[]) => (
		<TranscriptPerformanceHarness
			prompt="Threshold prompt"
			events={events}
			running
			phase="thinking"
			onSelectOption={() => {}}
		/>
	)
	const events: RuntimeEvent[] = Array.from({ length: 100 }, (_, index) => ({
		session_id: "threshold",
		task_id: `row-${index}`,
		kind: "thought",
		payload: { data: `Threshold row ${index}.` },
		created_at: 1_792_295_940_000 + index * 1_000,
	}))
	const component = await mount(view(events))
	const scroller = component.locator('[data-virtuoso-scroller="true"]').first()
	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight / 3
		element.dispatchEvent(new Event("scroll"))
	})
	await page.waitForTimeout(100)
	const reading = () =>
		scroller.evaluate((element) => {
			const top = element.getBoundingClientRect().top
			const paragraph = [...element.querySelectorAll("p")].find(
				(item) => item.getBoundingClientRect().bottom > top + 10,
			)
			return paragraph ? { text: paragraph.textContent, top: paragraph.getBoundingClientRect().top - top } : null
		})
	const before = await reading()
	expect(before?.text).toMatch(/Threshold row/)
	await component.update(
		view([...events, { ...events[0], task_id: "new-tail", payload: { data: "Threshold row 100." } }]),
	)
	await expect.poll(async () => (await reading())?.text).toBe(before?.text)
	expect(Math.abs(((await reading())?.top ?? Infinity) - (before?.top ?? 0))).toBeLessThan(4)
	await component.unmount()
})

test("same-millisecond batched events preserve the reading position when earlier payloads are prepended", async ({
	mount,
	page,
}) => {
	const view = (events: RuntimeEvent[]) => (
		<TranscriptPerformanceHarness
			prompt="Batched history fixture"
			events={events}
			running={false}
			phase="executing"
			onSelectOption={() => {}}
		/>
	)
	const eventFor = (title: string, path: string): RuntimeEvent => ({
		session_id: "batched-history",
		task_id: "one-batched-task",
		kind: "tool_call",
		payload: { toolName: "read_file", title, rawInput: { path }, status: "in_progress" },
		created_at: 1_792_295_940_000,
	})
	const events = Array.from({ length: 150 }, (_, index) => eventFor(`Batched row ${index}.`, `fixture-${index}.ts`))
	const component = await mount(view(events))
	const scroller = component.locator('[data-virtuoso-scroller="true"]').first()
	await expect(component.getByText("Batched row 149.")).toBeVisible()
	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight / 2
		element.dispatchEvent(new Event("scroll"))
	})
	await page.waitForTimeout(200)
	const reading = () =>
		scroller.evaluate((element) => {
			const top = element.getBoundingClientRect().top
			const paragraph = [...element.querySelectorAll("p")].find(
				(item) => item.getBoundingClientRect().bottom > top + 10,
			)
			return paragraph ? { text: paragraph.textContent, top: paragraph.getBoundingClientRect().top - top } : null
		})
	const before = await reading()
	expect(before?.text).toMatch(/Batched row/)
	const earlier = Array.from({ length: 3 }, (_, index) =>
		eventFor(`Earlier batched row ${index}.`, `earlier-${index}.ts`),
	)
	await component.update(view([...earlier, ...events]))
	await expect.poll(async () => (await reading())?.text).toBe(before?.text)
	expect(Math.abs(((await reading())?.top ?? Infinity) - (before?.top ?? 0))).toBeLessThan(4)
	await component.unmount()
})
