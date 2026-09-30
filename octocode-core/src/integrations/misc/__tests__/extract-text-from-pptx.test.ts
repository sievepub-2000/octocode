import fs from "fs/promises"
import os from "os"
import path from "path"

import JSZip from "jszip"
import { afterEach, describe, expect, it } from "vitest"

import { extractTextFromFile } from "../extract-text"

describe("PPTX extraction", () => {
	let directory: string | undefined

	afterEach(async () => {
		if (directory) await fs.rm(directory, { force: true, recursive: true })
	})

	it("returns slide text in numeric slide order", async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-pptx-"))
		const archive = new JSZip()
		archive.file("ppt/slides/slide10.xml", "<p:sld><a:t>Last &amp; final</a:t></p:sld>")
		archive.file("ppt/slides/slide2.xml", "<p:sld><a:t>Second</a:t></p:sld>")
		const file = path.join(directory, "slides.pptx")
		await fs.writeFile(file, await archive.generateAsync({ type: "nodebuffer" }))

		const text = await extractTextFromFile(file)

		expect(text).toContain("1 | Slide 1\n2 | Second")
		expect(text).toContain("4 | Slide 2\n5 | Last & final")
	})
})
