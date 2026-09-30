/**
 * Decides how much of the VS Code API an extension actually needs.
 *
 * The point of this classification is that "keep the marketplace" does not
 * require reimplementing VS Code. Most of the marketplace's value — language
 * support, themes, debuggers — is delivered either declaratively (JSON in the
 * VSIX) or over a standard protocol (LSP/DAP). Neither needs the `vscode` API
 * surface at all. Only extensions with real JavaScript logic do.
 *
 * Classification is intentionally conservative: when we cannot prove an
 * extension is purely declarative, we say it needs the API. Over-promising here
 * would surface as an extension that installs and then silently does nothing.
 */

export type ExtensionTier =
	/** Pure data: themes, grammars, snippets, language configs. Runs with no API. */
	| "declarative"
	/** Talks a standard protocol (LSP/DAP). Needs a process host, not the API. */
	| "protocol"
	/** Real extension code against the `vscode` API. Needs the shim. */
	| "api"

export interface ExtensionManifest {
	name?: string
	publisher?: string
	displayName?: string
	version?: string
	main?: string
	browser?: string
	engines?: Record<string, string>
	categories?: string[]
	activationEvents?: string[]
	contributes?: Record<string, unknown>
	extensionDependencies?: string[]
	extensionPack?: string[]
}

export interface Classification {
	tier: ExtensionTier
	/** Contribution points that work with no JavaScript at all. */
	declarativeContributions: string[]
	/** Why it landed in this tier, in one line the UI can show verbatim. */
	reason: string
	/** Extension ids this one pulls in, which must be classified too. */
	dependencies: string[]
}

/**
 * Contribution points that are pure data. VS Code itself reads these from the
 * manifest without ever calling into the extension, so any host that
 * understands the same JSON can honour them.
 */
const DECLARATIVE_CONTRIBUTIONS = new Set([
	"themes",
	"iconThemes",
	"productIconThemes",
	"grammars",
	"snippets",
	"languages",
	"configurationDefaults",
	"semanticTokenScopes",
	"semanticTokenTypes",
	"semanticTokenModifiers",
	"jsonValidation",
	"problemMatchers",
	"problemPatterns",
	"typescriptServerPlugins",
])

/** Contribution points served by a standard protocol rather than the API. */
const PROTOCOL_CONTRIBUTIONS = new Set(["debuggers", "breakpoints", "debugVisualizers"])

export function classifyExtension(manifest: ExtensionManifest): Classification {
	const contributes = manifest.contributes ?? {}
	const points = Object.keys(contributes)

	const declarative = points.filter((p) => DECLARATIVE_CONTRIBUTIONS.has(p))
	const protocol = points.filter((p) => PROTOCOL_CONTRIBUTIONS.has(p))
	const other = points.filter((p) => !DECLARATIVE_CONTRIBUTIONS.has(p) && !PROTOCOL_CONTRIBUTIONS.has(p))

	const dependencies = [...(manifest.extensionDependencies ?? []), ...(manifest.extensionPack ?? [])]

	// An entry point means real code runs. Even if every contribution looks
	// declarative, the code can call anything, so we cannot claim otherwise.
	const hasEntryPoint = Boolean(manifest.main || manifest.browser)

	if (!hasEntryPoint) {
		if (other.length === 0 && protocol.length === 0 && declarative.length > 0) {
			return {
				tier: "declarative",
				declarativeContributions: declarative,
				reason: `Pure data extension (${declarative.join(", ")}). Runs with no VS Code API.`,
				dependencies,
			}
		}
		if (other.length === 0 && protocol.length > 0) {
			return {
				tier: "protocol",
				declarativeContributions: declarative,
				reason: `Debug adapter (${protocol.join(", ")}) with no extension code. Runs over the debug protocol.`,
				dependencies,
			}
		}
		// No entry point and nothing we recognise: an extension pack, or contributions
		// we have not taught the host about yet. Treat as API rather than guess.
		return {
			tier: dependencies.length > 0 && points.length === 0 ? "declarative" : "api",
			declarativeContributions: declarative,
			reason:
				dependencies.length > 0 && points.length === 0
					? `Extension pack: installs ${dependencies.length} other extension(s).`
					: `Contributes ${other.join(", ") || "nothing recognised"}; needs host support.`,
			dependencies,
		}
	}

	return {
		tier: "api",
		declarativeContributions: declarative,
		reason: `Has an extension entry point (${manifest.main ? "main" : "browser"}); requires the VS Code API surface.`,
		dependencies,
	}
}

/**
 * Whether a language-server-backed extension is likely to work over LSP alone.
 *
 * This is a heuristic and is reported as such: VS Code extensions that wrap a
 * language server almost always still run JavaScript to start it, so they land
 * in the `api` tier. Knowing they are LSP-shaped tells the host it can likely
 * support them cheaply once it can start a server process.
 */
export function looksLikeLanguageServer(manifest: ExtensionManifest): boolean {
	const categories = (manifest.categories ?? []).map((c) => c.toLowerCase())
	const contributes = manifest.contributes ?? {}
	return (
		categories.includes("programming languages") &&
		Boolean(contributes.languages) &&
		Boolean(manifest.main || manifest.browser)
	)
}
