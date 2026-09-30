import * as fs from "node:fs"
import * as path from "node:path"

/**
 * The browser side of the evaluation manifest the harness enforces for
 * web_fetch and terminal commands (`.octocode/eval-manifest.json` in the
 * workspace). While a benchmark runs, navigating to a source that may hold its
 * answers is refused; without a manifest nothing changes.
 */
type EvalManifest = { blocked_url_prefixes?: string[] }

function normalise(url: string): string {
	const lower = url.trim().toLowerCase()
	const withoutScheme = lower.includes("://") ? lower.slice(lower.indexOf("://") + 3) : lower
	return withoutScheme.startsWith("www.") ? withoutScheme.slice(4) : withoutScheme
}

export function readEvalManifest(workspaceRoot: string | undefined): EvalManifest | undefined {
	if (!workspaceRoot) return undefined
	try {
		return JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".octocode", "eval-manifest.json"), "utf8"))
	} catch {
		return undefined
	}
}

/** Why the browser must not open `url` during an evaluation, if it must not. */
export function blockedBrowserUrl(manifest: EvalManifest | undefined, url: unknown): string | undefined {
	if (!manifest || typeof url !== "string" || !url) return undefined
	const target = normalise(url)
	const prefix = (manifest.blocked_url_prefixes ?? []).map(normalise).find((p) => p && target.startsWith(p))
	return prefix
		? `Blocked by the evaluation manifest: ${url} is under "${prefix}", a source that may contain this benchmark's answers. Solve the task from the provided materials instead.`
		: undefined
}
