import { useEffect, useRef, useState } from "react"
import type { ExtensionMessage } from "@roo-code/types"
import { Button, Input } from "@src/components/ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

export function CodeIndexSearch() {
	const { codeIndexWorkspacePath } = useExtensionState()
	const { t } = useAppTranslation()
	const [query, setQuery] = useState("")
	const [matches, setMatches] = useState<NonNullable<ExtensionMessage["codeIndexSearch"]>["matches"]>()
	const [error, setError] = useState<string>()
	const [pending, setPending] = useState(false)
	const active = useRef<string | undefined>(undefined)
	useEffect(() => {
		active.current = undefined
		setQuery("")
		setMatches(undefined)
		setError(undefined)
		setPending(false)
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			const result = event.data
			if (
				result.type !== "codeIndexSearchResult" ||
				result.requestId !== active.current ||
				!result.codeIndexSearch ||
				result.codeIndexSearch?.workspacePath !== codeIndexWorkspacePath
			)
				return
			setMatches(result.codeIndexSearch.matches)
			setError(result.error)
			setPending(false)
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [codeIndexWorkspacePath])
	return (
		<div className="space-y-3 py-4">
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(event) => {
					event.preventDefault()
					if (!codeIndexWorkspacePath || !query.trim() || pending) return
					active.current = crypto.randomUUID()
					setPending(true)
					setMatches(undefined)
					setError(undefined)
					vscode.postMessage({
						type: "searchCodeIndex",
						text: query.trim(),
						requestId: active.current,
						values: { workspacePath: codeIndexWorkspacePath },
					})
				}}>
				<Input
					className="min-w-0 flex-1"
					aria-label={t("settings:codeIndex.searchQuery")}
					maxLength={512}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					disabled={!codeIndexWorkspacePath || pending}
				/>
				<Button type="submit" disabled={!codeIndexWorkspacePath || !query.trim() || pending}>
					{t(pending ? "common:extensions.working" : "settings:codeIndex.searchButton")}
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-vscode-errorForeground">
					{error}
				</p>
			)}
			{matches?.length === 0 && !error && <p role="status">{t("settings:codeIndex.noSearchResults")}</p>}
			{matches?.map((match, index) => (
				<div
					key={`${match.filePath}:${match.startLine}:${index}`}
					className="border-b border-vscode-panel-border py-2">
					<Button
						variant="link"
						className="h-auto max-w-full whitespace-normal break-all p-0 text-left"
						onClick={() => vscode.postMessage({ type: "openFile", text: match.filePath })}>
						{match.filePath}:{match.startLine}
					</Button>
					<pre className="overflow-x-auto text-xs">{match.text}</pre>
				</div>
			))}
		</div>
	)
}
