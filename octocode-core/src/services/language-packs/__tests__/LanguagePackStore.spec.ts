import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { LanguagePackStore } from "../LanguagePackStore"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(pack: unknown) {
	const root = await mkdtemp(path.join(tmpdir(), "octocode-language-pack-"))
	roots.push(root)
	const source = path.join(root, "pack.json")
	await writeFile(source, JSON.stringify(pack))
	return { root, source, store: new LanguagePackStore(path.join(root, "installed")) }
}

describe("LanguagePackStore", () => {
	it("installs, lists, replaces and removes a valid pack atomically", async () => {
		const pack = { schemaVersion: 1, locale: "fr-CA", name: "Francais (Canada)", resources: { common: { save: "Enregistrer" } } }
		const { root, source, store } = await fixture(pack)

		await expect(store.install(source)).resolves.toEqual(pack)
		await writeFile(source, JSON.stringify({ ...pack, name: "Francais canadien" }))
		await expect(store.install(source)).resolves.toMatchObject({ name: "Francais canadien" })
		await expect(store.list()).resolves.toHaveLength(1)
		await expect(store.remove("fr-CA")).resolves.toBe(true)
		await expect(store.list()).resolves.toEqual([])
		expect(await readFile(path.join(root, "installed", "fr-CA.json"), "utf8").catch(() => "missing")).toBe("missing")
	})

	it.each([
		[{ schemaVersion: 1, locale: "../escape", name: "Bad", resources: { common: { value: "x" } } }, "locale"],
		[{ schemaVersion: 1, locale: "xx", name: "Bad", resources: { common: { value: 4 } } }, "strings"],
		[{ schemaVersion: 2, locale: "xx", name: "Bad", resources: {} }, "schemaVersion"],
	])("rejects an invalid pack", async (pack, message) => {
		const { source, store } = await fixture(pack)
		await expect(store.install(source)).rejects.toThrow(message)
	})

	it("rejects files larger than one megabyte", async () => {
		const { source, store } = await fixture({ schemaVersion: 1, locale: "xx", name: "Large", resources: {} })
		await writeFile(source, "x".repeat(1_048_577))
		await expect(store.install(source)).rejects.toThrow("one megabyte")
	})
})
