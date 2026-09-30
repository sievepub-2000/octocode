import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type LanguagePackManifest = {
	schemaVersion: 1
	locale: string
	name: string
	resources: Record<string, Record<string, unknown>>
}

const MAX_PACK_BYTES = 1_048_576
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]+$/

function assertStringLeaves(value: unknown): void {
	if (typeof value === "string") return
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Language-pack resources must contain strings or nested objects")
	}
	for (const child of Object.values(value)) assertStringLeaves(child)
}

export function parseLanguagePack(value: unknown): LanguagePackManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Language pack must be an object")
	const pack = value as Partial<LanguagePackManifest>
	if (pack.schemaVersion !== 1) throw new Error("Unsupported schemaVersion")
	if (typeof pack.locale !== "string" || !LOCALE_PATTERN.test(pack.locale)) throw new Error("Invalid locale")
	if (typeof pack.name !== "string" || !pack.name.trim() || pack.name.length > 80) throw new Error("Invalid name")
	if (!pack.resources || typeof pack.resources !== "object" || Array.isArray(pack.resources)) {
		throw new Error("Invalid resources")
	}
	for (const [namespace, resources] of Object.entries(pack.resources)) {
		if (!NAMESPACE_PATTERN.test(namespace)) throw new Error("Invalid namespace")
		assertStringLeaves(resources)
	}
	return pack as LanguagePackManifest
}

export class LanguagePackStore {
	constructor(private readonly directory: string) {}

	async install(source: string): Promise<LanguagePackManifest> {
		if ((await stat(source)).size > MAX_PACK_BYTES) throw new Error("Language pack exceeds one megabyte")
		const pack = parseLanguagePack(JSON.parse(await readFile(source, "utf8")))
		await mkdir(this.directory, { recursive: true })
		const destination = path.join(this.directory, `${pack.locale}.json`)
		const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
		await writeFile(temporary, JSON.stringify(pack), { encoding: "utf8", flag: "wx" })
		await rename(temporary, destination)
		return pack
	}

	async list(): Promise<LanguagePackManifest[]> {
		await mkdir(this.directory, { recursive: true })
		const entries = await readdir(this.directory, { withFileTypes: true })
		const packs = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map(async (entry) => parseLanguagePack(JSON.parse(await readFile(path.join(this.directory, entry.name), "utf8")))),
		)
		return packs.sort((left, right) => left.name.localeCompare(right.name))
	}

	async remove(locale: string): Promise<boolean> {
		if (!LOCALE_PATTERN.test(locale)) throw new Error("Invalid locale")
		try {
			await rm(path.join(this.directory, `${locale}.json`))
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
			throw error
		}
	}
}
