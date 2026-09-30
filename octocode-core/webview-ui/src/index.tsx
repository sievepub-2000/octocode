import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App"
import "../node_modules/@vscode/codicons/dist/codicon.css"

import { getHighlighter } from "./utils/highlighter"
import { vscode } from "./utils/vscode"

function formatLogValue(value: unknown): string {
	if (value instanceof Error) return value.stack ?? value.message
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

if (typeof acquireVsCodeApi === "function") {
	const forward = (level: "error" | "warn", source: string, values: unknown[]) =>
		vscode.postMessage({
			type: "webviewLog",
			payload: { level, source, message: values.map(formatLogValue).join(" ").slice(0, 4000) },
		})
	const originalError = console.error.bind(console)
	const originalWarn = console.warn.bind(console)
	console.error = (...values) => {
		originalError(...values)
		forward("error", "console.error", values)
	}
	console.warn = (...values) => {
		originalWarn(...values)
		forward("warn", "console.warn", values)
	}
	window.addEventListener("error", (event) => forward("error", "window.error", [event.error ?? event.message]))
	window.addEventListener("unhandledrejection", (event) =>
		forward("error", "window.unhandledrejection", [event.reason]),
	)
}

// Initialize Shiki early to hide initialization latency (async)
getHighlighter().catch((error: Error) => console.error("Failed to initialize Shiki highlighter:", error))

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
