/** Complete the VS Code CT fixtures using the production palette for unspecified colors.
 * Run with `pnpm exec tsx scripts/generate-ct-theme-defaults.ts [--check]`.
 * Explicit Default Light/Dark colors remain stable for existing visual baselines.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildThemeVariables } from "../src/theme/tokens"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const marker = "/* Generated missing colors: scripts/generate-ct-theme-defaults.ts */"
const check = process.argv.includes("--check")

for (const [kind, theme, selector] of [
	["dark", "midnight-purple", ":root"],
	["light", "solarized-light", ".vscode-light"],
] as const) {
	const file = path.join(root, "playwright", `vscode-theme-${kind}.css`)
	const original = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
	const explicit = original.split(marker)[0].trimEnd()
	const defined = new Set([...explicit.matchAll(/(--vscode-[\w-]+)\s*:/g)].map((match) => match[1]))
	const missing = Object.entries(buildThemeVariables(theme)).filter(
		([name]) => name.startsWith("--vscode-") && !defined.has(name),
	)
	const generated = `${explicit}\n\n${marker}\n${selector} {\n${missing.map(([name, value]) => `\t${name}: ${value};`).join("\n")}\n}\n`
	if (check) assert.equal(original, generated, `${kind} fixture defaults drifted; regenerate them`)
	else fs.writeFileSync(file, generated)
	console.log(
		`${kind}: ${defined.size} explicit variables, ${missing.length} production defaults ${check ? "verified" : "generated"}`,
	)
}
