// Verify the CSS code points against each font's Unicode cmap, without extra dependencies.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function checkPair(directory) {
	const css = fs.readFileSync(path.join(directory, "codicon.css"), "utf8")
	const font = fs.readFileSync(path.join(directory, "codicon.ttf"))
	const tables = new Map()
	for (let i = 0; i < font.readUInt16BE(4); i++) {
		const entry = 12 + 16 * i
		tables.set(font.toString("ascii", entry, entry + 4), font.readUInt32BE(entry + 8))
	}
	const cmap = tables.get("cmap")
	assert.ok(cmap !== undefined, "TTF must contain cmap")
	const glyphCount = font.readUInt16BE(tables.get("maxp") + 4)
	const subtables = []
	for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
		const entry = cmap + 4 + i * 8
		const platform = font.readUInt16BE(entry)
		const encoding = font.readUInt16BE(entry + 2)
		if (platform === 0 || (platform === 3 && [1, 10].includes(encoding)))
			subtables.push(cmap + font.readUInt32BE(entry + 4))
	}
	function glyphFor(code, p) {
		const format = font.readUInt16BE(p)
		if (format === 4 && code <= 0xffff) {
			const count = font.readUInt16BE(p + 6) / 2
			for (let i = 0; i < count; i++) {
				const end = font.readUInt16BE(p + 14 + i * 2)
				const start = font.readUInt16BE(p + 16 + count * 2 + i * 2)
				if (code < start || code > end) continue
				const delta = font.readInt16BE(p + 16 + count * 4 + i * 2)
				const rangePosition = p + 16 + count * 6 + i * 2
				const range = font.readUInt16BE(rangePosition)
				if (!range) return (code + delta) & 0xffff
				const glyph = font.readUInt16BE(rangePosition + range + (code - start) * 2)
				return glyph ? (glyph + delta) & 0xffff : 0
			}
		} else if (format === 12) {
			for (let i = 0; i < font.readUInt32BE(p + 12); i++) {
				const group = p + 16 + i * 12
				const start = font.readUInt32BE(group)
				if (code >= start && code <= font.readUInt32BE(group + 4))
					return font.readUInt32BE(group + 8) + code - start
			}
		}
		return 0
	}
	const icons = new Map()
	for (const match of css.matchAll(/([^{}]+)\{[^{}]*content:\s*["']\\([0-9a-f]+)["'][^{}]*\}/gi)) {
		const code = parseInt(match[2], 16)
		assert.ok(
			subtables.some((p) => {
				const glyph = glyphFor(code, p)
				return glyph > 0 && glyph < glyphCount
			}),
			`Missing glyph U+${match[2]} in ${directory}`,
		)
		for (const selector of match[1].matchAll(/\.codicon-([\w-]+):/g)) icons.set(selector[1], code)
	}
	assert.ok(icons.size > 400, "Expected a complete icon CSS mapping")
	console.log(
		`${directory}: ${icons.size} CSS names, ${new Set(icons.values()).size} codepoints, all cmap glyphs present`,
	)
	return icons
}

const production = checkPair(path.join(root, "src/assets/codicons"))
const dependency = checkPair(path.join(root, "webview-ui/node_modules/@vscode/codicons/dist"))
const changed = [...production].filter(([name, code]) => dependency.has(name) && dependency.get(name) !== code)
console.log(
	JSON.stringify({
		productionOnly: [...production.keys()].filter((name) => !dependency.has(name)),
		changedCodepoints: changed,
		dependencyOnlyCount: [...dependency.keys()].filter((name) => !production.has(name)).length,
	}),
)
assert.match(
	fs.readFileSync(path.join(root, "webview-ui/playwright/index.tsx"), "utf8"),
	/import "\.\.\/\.\.\/src\/assets\/codicons\/codicon\.css"/,
)
console.log("CT and production use the same packaged CSS/font pair")
