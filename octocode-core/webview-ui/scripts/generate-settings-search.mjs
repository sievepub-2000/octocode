import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = fileURLToPath(new URL("../src/components/", import.meta.url))
const entries = new Map()
function scan(directory) {
	for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, item.name)
		if (item.isDirectory()) {
			if (item.name !== "__tests__") scan(file)
			continue
		}
		if (!item.name.endsWith(".tsx")) continue
		const text = fs.readFileSync(file, "utf8")
		if (!text.includes("<SearchableSetting")) continue
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
		function visit(node) {
			if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "SearchableSetting") {
				const attributes = new Map(
					node.attributes.properties
						.filter(ts.isJsxAttribute)
						.map((a) => [a.name.getText(source), a.initializer]),
				)
				const literal = (node) => (node && ts.isStringLiteral(node) ? node.text : undefined)
				const settingId = literal(attributes.get("settingId")),
					section = literal(attributes.get("section"))
				const label = attributes.get("label")
				const expression = label && ts.isJsxExpression(label) ? label.expression : undefined
				const labelKey =
					expression && ts.isCallExpression(expression) && expression.expression.getText(source) === "t"
						? literal(expression.arguments[0])
						: undefined
				const fixedLabel = literal(label) ?? literal(expression)
				// Dynamic provider-specific controls still register when their page is opened.
				if (settingId && section && (labelKey || fixedLabel))
					entries.set(settingId, {
						settingId,
						section,
						labelKey: labelKey ?? null,
						label: fixedLabel ?? null,
					})
			}
			ts.forEachChild(node, visit)
		}
		visit(source)
	}
}
scan(root)
const output = path.join(root, "settings/settings-search.generated.json")
const content =
	JSON.stringify(
		[...entries.values()].sort((a, b) => a.settingId.localeCompare(b.settingId)),
		null,
		2,
	) + "\n"
if (process.argv.includes("--check")) {
	if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== content)
		throw Error("Settings search index is stale; run node scripts/generate-settings-search.mjs")
} else if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== content) fs.writeFileSync(output, content)
console.log(`Settings search metadata: ${entries.size} controls, no UI mounted`)
