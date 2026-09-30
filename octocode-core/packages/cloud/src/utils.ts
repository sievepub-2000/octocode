import type { ExtensionContext } from "vscode"

export function getUserAgent(context?: ExtensionContext): string {
	return `OctoCode ${context?.extension?.packageJSON?.version || "unknown"}`
}
