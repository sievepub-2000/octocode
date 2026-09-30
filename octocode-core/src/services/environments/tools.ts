import * as path from "path"

/** One product-wide tool root; workspace settings must never affect it. */
export function getSystemToolDirectory(kind: "skills" | "mcp" | "hooks"): string | undefined {
	const root = process.env.OCTOCODE_ENVIRONMENTS
	if (!root) return undefined
	if (!path.isAbsolute(root)) throw new Error("OCTOCODE_ENVIRONMENTS must be an absolute path")
	return path.join(root, "tools", kind)
}

export function getSystemSkillsDirectory(mode?: string): string | undefined {
	const root = getSystemToolDirectory("skills")
	if (!root || !mode) return root
	if (!/^[a-zA-Z0-9_-]+$/.test(mode)) throw new Error("Invalid skill mode")
	return path.join(root, ".modes", mode)
}
