# OctoCode Language Packs and Full Audit Design

## Approved outcome

- `OCTOCODE` is fixed at the application window's top-left as a classic desktop product mark. It is not part of the sidebar menu row.
- Sidebar actions begin at the left edge, fill available width, and move excess actions into an ellipsis menu.
- The artifact area starts at roughly 75% of the right column and the terminal at roughly 25%; all separators remain native, draggable and collapsible.
- The existing 17 built-in languages remain explicitly selectable. Installed external language packs appear in the same selector.
- Every module and every visible menu entry receives source review plus a real behavior check where the Windows host exposes it.

## External language-pack format

One UTF-8 JSON file is an atomic installable unit:

```json
{
	"schemaVersion": 1,
	"locale": "fr-CA",
	"name": "Francais (Canada)",
	"resources": {
		"common": { "save": "Enregistrer" },
		"settings": { "sections": { "language": "Langue" } }
	}
}
```

The extension host validates the schema, BCP-47-like locale identifier, one-megabyte size ceiling, namespace names, and string-only leaves. Valid packs are copied to the extension global-storage `language-packs` directory. Invalid packs never reach the webview. Partial packs inherit missing strings from English. Installation, removal and enumeration use extension-host messages; webviews never receive arbitrary filesystem paths.

## Audit and verification

Semgrep Community Edition is installed in an isolated virtual environment and runs locally without login. It supplements, not replaces, repository ESLint, TypeScript, Vitest, Python unittest and production builds. Findings are reproduced and fixed test-first. Runtime verification records executable, working directory, effective extension/config/data locations, permissions, duplicate data roots, menu/module lifecycle, cold start, restart persistence, model chat/tool-calls/Responses API, MCP health, and preserved conversation storage.

Windows is the real tested platform. Linux and macOS path/syntax compatibility is statically checked and reported separately unless real hosts become available. No unexecuted platform is reported as tested.
