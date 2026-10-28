import { useCallback, useEffect, useRef, useState } from "react"

import type { ExtensionAction, ExtensionEntry, ExtensionKind, ExtensionResult } from "@roo-code/types"

import { Button } from "@/components/ui/button"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

/**
 * Installed and installable entries of one extension kind, with exactly the
 * actions the extension-side registry allows. Every kind uses this same list and
 * the same `extensionRequest` message, so install/uninstall/enable behave alike.
 */
export function ExtensionList({
	kind,
	hint,
	searchable,
	tabs = false,
}: {
	kind: ExtensionKind
	hint?: string
	searchable?: boolean
	tabs?: boolean
}) {
	const { t } = useAppTranslation()
	const [entries, setEntries] = useState<ExtensionEntry[]>()
	const [pending, setPending] = useState<string>()
	const [error, setError] = useState<string>()
	const [query, setQuery] = useState("")
	const [page, setPage] = useState<"market" | "installed">("market")
	const [pageNumber, setPageNumber] = useState(1)
	const [nextCursor, setNextCursor] = useState<string>()
	const appendRequest = useRef<string | undefined>(undefined)
	const activeRequest = useRef<string | undefined>(undefined)
	const loadedCount = useRef(0)

	const send = useCallback(
		(action: ExtensionAction | "list", entry?: ExtensionEntry, cursor?: string) => {
			const requestId = crypto.randomUUID()
			activeRequest.current = requestId
			appendRequest.current = cursor === undefined ? undefined : requestId
			if (cursor !== undefined) setPending("next-page")
			if (entry) setPending(`${entry.id}:${action}`)
			vscode.postMessage({
				type: "extensionRequest",
				payload:
					action === "list" || !entry
						? {
								action: "list",
								kind,
								requestId,
								...(tabs ? { page } : {}),
								...(query.trim() ? { query: query.trim() } : {}),
								...(cursor === undefined ? {} : { cursor }),
							}
						: {
								action,
								kind,
								id: entry.id,
								requestId,
								...(tabs ? { page } : {}),
								...(entry.scope !== "system" ? { scope: entry.scope } : {}),
								...(query.trim() ? { query: query.trim() } : {}),
							},
			})
		},
		[kind, query, page, tabs],
	)

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "extensionState") return
			const result = event.data.payload as ExtensionResult
			if (result.requestId !== activeRequest.current) return
			if (appendRequest.current === result.requestId && result.error) {
				setError(result.error)
				setPending(undefined)
				return
			}
			const incoming = result.entries.filter((entry) => entry.kind === kind)
			setEntries((previous) => {
				const merged = new Map(
					(appendRequest.current === result.requestId ? (previous ?? []) : []).map((entry) => [
						`${entry.scope}:${entry.id}`,
						entry,
					]),
				)
				for (const entry of incoming) merged.set(`${entry.scope}:${entry.id}`, entry)
				return [...merged.values()]
			})
			if (appendRequest.current === result.requestId) {
				if (loadedCount.current > 0 && loadedCount.current % 20 === 0) setPageNumber((number) => number + 1)
			} else setPageNumber(1)
			setNextCursor(result.nextCursor)
			setError(result.error)
			setPending(undefined)
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [kind])

	useEffect(() => {
		activeRequest.current = undefined
		setEntries(undefined)
		setPageNumber(1)
		setNextCursor(undefined)
		setError(undefined)
		if (!query) {
			send("list")
			return
		}
		// Debounced so typing a search does not hit the gallery on every keystroke.
		const timer = setTimeout(() => send("list"), 400)
		return () => clearTimeout(timer)
	}, [query, send])
	const filtered = entries
		?.filter(
			(entry) =>
				(!tabs || page !== "installed" || entry.installed) &&
				(!query.trim() ||
					`${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())),
		)
		.sort((a, b) => Number(b.installed) - Number(a.installed) || (b.rank ?? -1) - (a.rank ?? -1))
	const pageCount = Math.max(1, Math.ceil((filtered?.length ?? 0) / 20))
	loadedCount.current = filtered?.length ?? 0
	useEffect(() => {
		if (pageNumber > pageCount) setPageNumber(pageCount)
	}, [pageNumber, pageCount])
	const visible = filtered?.slice((Math.min(pageNumber, pageCount) - 1) * 20, Math.min(pageNumber, pageCount) * 20)

	return (
		<div className="space-y-2" data-testid={`extension-list-${kind}`}>
			{tabs && (
				<div
					role="tablist"
					aria-label={t("common:extensions.market")}
					className="flex gap-2 border-b border-vscode-panel-border pb-2">
					{(["market", "installed"] as const).map((value) => (
						<Button
							key={value}
							role="tab"
							aria-selected={page === value}
							disabled={!!pending}
							variant={page === value ? "primary" : "secondary"}
							size="sm"
							onClick={() => setPage(value)}>
							{t(`common:extensions.${value}`)}
						</Button>
					))}
				</div>
			)}
			{hint && <p className="m-0 text-xs text-vscode-descriptionForeground">{hint}</p>}
			{searchable && (
				<input
					type="search"
					aria-label={t("common:extensions.search")}
					placeholder={t("common:extensions.search")}
					value={query}
					disabled={!!pending}
					onChange={(event) => setQuery(event.target.value)}
					className="w-full rounded border border-vscode-input-border bg-vscode-input-background px-2 py-1 text-sm text-vscode-input-foreground"
				/>
			)}
			{error && (
				<p role="alert" className="m-0 text-xs text-vscode-errorForeground">
					{error}
				</p>
			)}
			{!entries && (
				<p role="status" className="text-xs">
					{t("common:extensions.working")}
				</p>
			)}
			{visible?.length === 0 && <p className="text-sm">{t("common:extensions.empty")}</p>}
			<div className={tabs ? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2" : "space-y-2"}>
				{visible?.map((entry) => (
					<div
						key={`${entry.scope}:${entry.id}`}
						data-testid={`extension-${entry.id}`}
						className="flex min-w-0 flex-col gap-3 rounded border border-vscode-panel-border bg-vscode-editor-background p-3">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2 text-sm font-medium">
								<span className="break-all">{entry.name}</span>
								<span className="text-xs font-normal text-vscode-descriptionForeground">
									{entry.installed
										? t("common:extensions.installed")
										: t("common:extensions.available")}
									{entry.builtIn ? ` · ${t("common:extensions.builtIn")}` : ""}
									{entry.detail ? ` · ${entry.detail}` : ""}
								</span>
							</div>
							{entry.description && (
								<p
									className="m-0 mt-1 line-clamp-3 break-words text-xs text-vscode-descriptionForeground"
									title={entry.description}>
									{entry.description}
								</p>
							)}
						</div>
						<div className="mt-auto flex flex-wrap justify-end gap-1">
							{kind === "mcp" && entry.installed && tabs && (
								<Button
									size="sm"
									variant="secondary"
									disabled={!!pending}
									onClick={() => vscode.postMessage({ type: "openMcpSettings" })}>
									{t("common:octocode.settings")}
								</Button>
							)}
							{entry.actions.map((action) => (
								<Button
									key={action}
									size="sm"
									variant={action === "install" || action === "enable" ? "primary" : "secondary"}
									disabled={pending !== undefined}
									onClick={() => send(action, entry)}>
									{pending === `${entry.id}:${action}`
										? t("common:extensions.working")
										: t(`common:extensions.${action}`)}
								</Button>
							))}
						</div>
					</div>
				))}
			</div>
			{entries && (
				<nav
					aria-label={t("common:extensions.pagination")}
					className="flex flex-wrap items-center justify-center gap-2 py-2">
					<Button
						size="sm"
						variant="secondary"
						disabled={!!pending || pageNumber <= 1}
						onClick={() => setPageNumber((number) => number - 1)}>
						{t("common:extensions.previousPage")}
					</Button>
					{Array.from(
						{ length: Math.min(7, pageCount) },
						(_, index) => Math.max(1, Math.min(pageNumber - 3, pageCount - 6)) + index,
					).map((number) => (
						<Button
							key={number}
							size="sm"
							variant={Math.min(pageNumber, pageCount) === number ? "primary" : "secondary"}
							aria-current={Math.min(pageNumber, pageCount) === number ? "page" : undefined}
							aria-label={t("common:extensions.pageNumber", { number })}
							disabled={!!pending}
							onClick={() => setPageNumber(number)}>
							{number}
						</Button>
					))}
					<span aria-live="polite" className="text-xs">
						{Math.min(pageNumber, pageCount)} / {pageCount}
						{nextCursor ? "+" : ""}
					</span>
					<Button
						size="sm"
						variant="secondary"
						disabled={!!pending || (pageNumber >= pageCount && !nextCursor)}
						onClick={() =>
							pageNumber < pageCount
								? setPageNumber((number) => number + 1)
								: send("list", undefined, nextCursor)
						}>
						{t("common:extensions.nextPage")}
					</Button>
				</nav>
			)}
		</div>
	)
}
