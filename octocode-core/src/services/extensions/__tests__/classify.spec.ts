import { classifyExtension, looksLikeLanguageServer, type ExtensionManifest } from "../classify"
import { satisfiesEngine, toGalleryExtension } from "../open-vsx"

describe("extension classification", () => {
	it("treats a colour theme as pure data", () => {
		const theme: ExtensionManifest = {
			name: "dracula",
			contributes: { themes: [{ label: "Dracula", path: "./themes/dracula.json" }] },
		}
		const result = classifyExtension(theme)
		expect(result.tier).toBe("declarative")
		expect(result.declarativeContributions).toEqual(["themes"])
	})

	it("treats a grammar + language config bundle as pure data", () => {
		const grammar: ExtensionManifest = {
			name: "toml",
			contributes: {
				languages: [{ id: "toml", extensions: [".toml"] }],
				grammars: [{ language: "toml", scopeName: "source.toml", path: "./toml.tmLanguage.json" }],
			},
		}
		expect(classifyExtension(grammar).tier).toBe("declarative")
	})

	it("routes a pure debug adapter to the protocol tier", () => {
		const debugger_: ExtensionManifest = {
			name: "lldb",
			contributes: { debuggers: [{ type: "lldb" }], breakpoints: [{ language: "c" }] },
		}
		const result = classifyExtension(debugger_)
		expect(result.tier).toBe("protocol")
		expect(result.reason).toMatch(/debug protocol/i)
	})

	it("requires the API as soon as the extension ships code", () => {
		// Even if every contribution looks declarative, `main` means arbitrary code
		// runs and may call anything. Claiming otherwise would install extensions
		// that then silently do nothing.
		const withCode: ExtensionManifest = {
			name: "themed-but-active",
			main: "./out/extension.js",
			contributes: { themes: [{ label: "X", path: "./x.json" }] },
		}
		const result = classifyExtension(withCode)
		expect(result.tier).toBe("api")
		expect(result.reason).toMatch(/entry point/i)
	})

	it("treats a web-only entry point as code too", () => {
		expect(classifyExtension({ name: "web", browser: "./dist/web.js" }).tier).toBe("api")
	})

	it("recognises an extension pack as installable without the API", () => {
		const pack: ExtensionManifest = {
			name: "python-pack",
			extensionPack: ["ms-python.python", "ms-python.debugpy"],
		}
		const result = classifyExtension(pack)
		expect(result.tier).toBe("declarative")
		expect(result.dependencies).toEqual(["ms-python.python", "ms-python.debugpy"])
		expect(result.reason).toMatch(/pack/i)
	})

	it("does not claim support for contribution points the host does not know", () => {
		const unknown: ExtensionManifest = {
			name: "mystery",
			contributes: { someFutureContribution: [{}] },
		}
		expect(classifyExtension(unknown).tier).toBe("api")
	})

	it("reports dependencies so they can be classified too", () => {
		const dependent: ExtensionManifest = {
			name: "child",
			main: "./x.js",
			extensionDependencies: ["ms-python.python"],
		}
		expect(classifyExtension(dependent).dependencies).toEqual(["ms-python.python"])
	})

	it("flags LSP-shaped extensions as cheap to support later", () => {
		expect(
			looksLikeLanguageServer({
				name: "rust-analyzer",
				main: "./out/main.js",
				categories: ["Programming Languages"],
				contributes: { languages: [{ id: "rust" }] },
			}),
		).toBe(true)

		expect(looksLikeLanguageServer({ name: "theme", contributes: { themes: [] } })).toBe(false)
	})
})

describe("engine compatibility", () => {
	it.each([
		["^1.95.0", "1.96.0", true],
		["^1.95.0", "1.95.0", true],
		["^1.95.0", "1.94.0", false],
		[">=1.80.0", "1.96.2", true],
		["*", "1.0.0", true],
		[undefined, "1.0.0", true],
	])("engine %s against host %s -> %s", (range, host, expected) => {
		expect(satisfiesEngine(range as string | undefined, host)).toBe(expected)
	})

	it("declines ranges it cannot parse rather than assuming compatibility", () => {
		// Installing on a bad guess produces a runtime failure the user cannot explain.
		expect(satisfiesEngine("not-a-range", "1.96.0")).toBe(false)
	})
})

describe("gallery mapping", () => {
	it("builds the publisher.name id callers expect", () => {
		const ext = toGalleryExtension({ namespace: "ms-python", name: "python", version: "2026.4.0" })
		expect(ext.id).toBe("ms-python.python")
		expect(ext.version).toBe("2026.4.0")
	})
})
