/**
 * Writes the shipped VS Code colour themes from the OctoCode palette.
 *
 *   pnpm --filter webview-ui generate:themes [outDir]
 *
 * The output is committed, so this is not part of the build; it is re-run when
 * the palette changes. `src/theme/__tests__/vscodeTheme.spec.ts` regenerates in
 * memory and compares, so a palette edit without a re-run fails the test suite
 * rather than silently shipping stale colours.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { buildAllThemePreviews, buildAllVsCodeThemes, buildInitialColorsModule } from "../src/theme/vscodeTheme"

const here = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.resolve(here, "../../../desktop-shell")
const DEFAULT_OUT = path.join(SHELL, "extensions/octocode-themes/themes")
const INITIAL_COLORS_OUT = path.join(SHELL, "src/vs/workbench/services/themes/common/octocodeInitialColors.ts")
const PREVIEWS_OUT = path.join(SHELL, "src/vs/workbench/contrib/welcomeGettingStarted/common/media")

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT
fs.mkdirSync(outDir, { recursive: true })

for (const [filename, theme] of Object.entries(buildAllVsCodeThemes())) {
	const target = path.join(outDir, filename)
	fs.writeFileSync(target, `${JSON.stringify(theme, null, "\t")}\n`, "utf8")
	console.log(`wrote ${path.relative(process.cwd(), target)} (${Object.keys(theme.colors).length} colours)`)
}

// Only written when the default output location is in use: a caller pointing the
// themes somewhere else (a scratch dir, a test) is not asking to rewrite the shell.
if (!process.argv[2]) {
	fs.writeFileSync(INITIAL_COLORS_OUT, buildInitialColorsModule(), "utf8")
	console.log(`wrote ${path.relative(process.cwd(), INITIAL_COLORS_OUT)}`)

	for (const [filename, svg] of Object.entries(buildAllThemePreviews())) {
		const target = path.join(PREVIEWS_OUT, filename)
		fs.writeFileSync(target, svg, "utf8")
		console.log(`wrote ${path.relative(process.cwd(), target)}`)
	}
}
