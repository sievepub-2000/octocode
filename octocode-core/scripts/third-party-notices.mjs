import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import console from "node:console"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cache = JSON.parse(fs.readFileSync(path.join(root, "scripts", "licenses", "npm-license-cache.json"), "utf8"))
const licenseName = /^(?:licen[cs]e|copying|copyright|notice|ofl)(?:[._-]|$)/i

function licenseFiles(directory, depth = 0) {
	const result = []
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink() || entry.name === "node_modules") continue
		const file = path.join(directory, entry.name)
		if (entry.isDirectory() && depth < 2) result.push(...licenseFiles(file, depth + 1))
		else if (entry.isFile() && (licenseName.test(entry.name) || /[/\\]licenses[/\\]/i.test(file))) {
			result.push({ source: path.relative(directory, file), text: fs.readFileSync(file, "utf8") })
		}
	}
	return result
}

function packageDirectory(input) {
	const file = input.split("?")[0]
	if (file.startsWith("\0") || !fs.existsSync(file)) return undefined
	const real = fs.realpathSync(file)
	if (!real.includes(`${path.sep}node_modules${path.sep}`)) return undefined
	let directory = fs.statSync(real).isDirectory() ? real : path.dirname(real)
	while (directory !== path.dirname(directory)) {
		const manifest = path.join(directory, "package.json")
		if (fs.existsSync(manifest)) {
			const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"))
			if (pkg.name && pkg.version) return { directory, pkg }
		}
		directory = path.dirname(directory)
	}
	return undefined
}

/** Build-time inventory follows actual bundle inputs; missing license evidence fails the build. */
export function writeThirdPartyNotices(inputs, destination, extraInputs = []) {
	for (const input of extraInputs) {
		if (!fs.existsSync(input)) throw new Error(`Required third-party component not found: ${input}`)
	}
	const packages = new Map()
	for (const input of [...inputs, ...extraInputs]) {
		const entry = packageDirectory(input)
		if (entry) packages.set(`${entry.pkg.name}@${entry.pkg.version}`, entry)
	}
	const notices = ["NOTICES AND INFORMATION: third-party components included in this OctoCode artifact."]
	const inventory = []
	const missing = []
	for (const [key, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
		const supplied = licenseFiles(directory)
		const stored = cache.packages[key]
		const files = [...(supplied.length ? supplied : (stored?.files ?? [])), ...(stored?.supplements ?? [])]
		const assetSupplementMissing = ["katex", "@vscode/codicons"].includes(pkg.name) && !stored?.supplements?.length
		if (!files.length || !files.some((file) => file.text.trim().length > 150) || assetSupplementMissing) {
			missing.push({ name: pkg.name, version: pkg.version, directory, license: pkg.license })
			continue
		}
		const license = pkg.license ?? stored?.license ?? "See upstream license texts"
		notices.push(
			`\n---------------------------------------------------------\n\n${pkg.name} ${pkg.version} - ${typeof license === "string" ? license : JSON.stringify(license)}\n`,
		)
		if (pkg.repository)
			notices.push(`Upstream: ${typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url}`)
		if (pkg.author)
			notices.push(`Published author: ${typeof pkg.author === "string" ? pkg.author : pkg.author.name}`)
		for (const file of files) notices.push(`Source: ${file.source}\n\n${file.text.trim()}\n`)
		inventory.push({
			name: pkg.name,
			version: pkg.version,
			files: files.map((file) => ({
				source: file.source,
				sha256: createHash("sha256").update(file.text).digest("hex"),
			})),
		})
	}
	fs.mkdirSync(path.dirname(destination), { recursive: true })
	if (missing.length) {
		fs.writeFileSync(`${destination}.missing.json`, `${JSON.stringify(missing, null, 2)}\n`)
		throw new Error(
			`Missing complete license evidence: ${missing.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`,
		)
	}
	fs.rmSync(`${destination}.missing.json`, { force: true })
	fs.writeFileSync(destination, `${notices.join("\n")}\n`)
	// Evidence accompanies the license text, with no machine paths or runtime data.
	fs.writeFileSync(`${destination}.json`, `${JSON.stringify(inventory, null, 2)}\n`)
	console.log(`[third-party notices] ${packages.size} packages -> ${path.relative(root, destination)}`)
}
