/**
 * One contract for everything that extends the agent.
 *
 * MCP servers, skills, agent modes, runtime environments and VS Code extensions used to be listed,
 * installed and removed through four unrelated paths. They now share this shape:
 * the component market is the single install/uninstall surface, settings is the
 * single configuration surface, the agent reaches them through the workbench
 * `tools` hub, and the daemon lists them at `/v1/extensions`.
 */

export const extensionKinds = ["mcp", "skill", "mode", "environment", "extension"] as const
export type ExtensionKind = (typeof extensionKinds)[number]

export type ExtensionScope = "global" | "project" | "system"

export type ExtensionAction = "install" | "uninstall" | "enable" | "disable"

export type ExtensionEntry = {
	kind: ExtensionKind
	/** Stable id within its kind: server name, skill name, mode slug, environment id. */
	id: string
	name: string
	description?: string
	scope: ExtensionScope
	installed: boolean
	/** Only meaningful for kinds that can be switched off without uninstalling (MCP). */
	enabled?: boolean
	/** Shipped with the product (core environments cannot be removed). */
	builtIn: boolean
	/** Actions valid for this entry right now; the UI renders exactly these. */
	actions: ExtensionAction[]
	/** Short state note, e.g. download size or connection status. */
	detail?: string
}

export type ExtensionRequest = {
	requestId?: string
	page?: "market" | "installed"
} & (
	| { action: "list"; kind?: ExtensionKind; query?: string }
	/** `query` keeps a searched list (VS Code extensions) in the result after the action. */
	| { action: ExtensionAction; kind: ExtensionKind; id: string; scope?: "global" | "project"; query?: string }
)

export type ExtensionResult = { entries: ExtensionEntry[]; error?: string; requestId?: string }
