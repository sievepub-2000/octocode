import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Search, Trash2 } from "lucide-react"

import { Button, Input } from "@/components/ui"
import { vscode } from "@src/utils/vscode"

const localDate = (value: string, nextDay = false) => {
	if (!value) return undefined
	const [year, month, day] = value.split("-").map(Number)
	return new Date(year, month - 1, day + Number(nextDay)).getTime()
}

const LogsView = () => {
	const { t } = useTranslation(["common", "settings"])
	const [category, setCategory] = useState<"system" | "developer">("system")
	const [keyword, setKeyword] = useState("")
	const [startDate, setStartDate] = useState("")
	const [endDate, setEndDate] = useState("")
	const [retention, setRetention] = useState(30)
	const settingRequest = useRef("")
	const refreshAfter = useRef(new Set<string>())

	const request = useCallback((method: string, params: unknown = {}) => {
		const requestId = crypto.randomUUID()
		vscode.postMessage({ type: "runtimeRequest", payload: { requestId, method, params } })
		return requestId
	}, [])

	const filter = useCallback(
		() => ({
			keyword: keyword.trim() || undefined,
			from: localDate(startDate),
			to: localDate(endDate, true),
		}),
		[endDate, keyword, startDate],
	)
	const query = useCallback(
		() => request("log.list", { category, ...filter(), limit: 1000 }),
		[category, filter, request],
	)
	const selectCategory = (next: "system" | "developer") => {
		setCategory(next)
		request("log.list", { category: next, ...filter(), limit: 1000 })
	}
	const hasFilter = Boolean(keyword.trim() || startDate || endDate)
	const queryRef = useRef(query)
	queryRef.current = query

	useEffect(() => {
		settingRequest.current = request("setting.get", { key: "log.retention_days" })
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "runtimeResponse") return
			const { requestId, result } = event.data.payload ?? {}
			if (requestId === settingRequest.current && Number.isInteger(result)) setRetention(result)
			if (refreshAfter.current.delete(requestId)) queryRef.current()
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [request])

	const saveRetention = () => {
		const days = Math.max(1, Math.min(3650, retention || 30))
		setRetention(days)
		request("setting.set", { key: "log.retention_days", value: days })
		refreshAfter.current.add(request("log.purge", { retention_days: days }))
	}
	const deleteMatching = () =>
		refreshAfter.current.add(request("log.delete_matching", { category, ...filter() }))
	const clearAll = () => refreshAfter.current.add(request("log.clear", { category }))

	return (
		<section className="space-y-5 p-5" aria-label={t("octocode.systemLogs")}>
			<header>
				<h2 className="m-0 text-lg">{t("octocode.logs")}</h2>
				<p className="m-0 mt-1 text-vscode-descriptionForeground">{t("settings:logs.inspectorHint")}</p>
			</header>
			<div className="flex gap-2" role="group" aria-label={t("settings:logs.category")}>
				{(["system", "developer"] as const).map((value) => (
					<Button
						aria-label={t(`settings:logs.${value}`)}
						aria-pressed={category === value}
						key={value}
						variant={category === value ? "primary" : "secondary"}
						onClick={() => selectCategory(value)}>
						{t(`settings:logs.${value}`)}
					</Button>
				))}
			</div>
			<div className="grid gap-3 sm:grid-cols-3">
				<label className="space-y-1">
					<span>{t("settings:logs.keyword")}</span>
					<Input
						aria-label={t("settings:logs.keyword")}
						value={keyword}
						onChange={(event) => setKeyword(event.target.value)}
					/>
				</label>
				<label className="space-y-1">
					<span>{t("settings:logs.startDate")}</span>
					<Input
						aria-label={t("settings:logs.startDate")}
						type="date"
						value={startDate}
						onChange={(event) => setStartDate(event.target.value)}
					/>
				</label>
				<label className="space-y-1">
					<span>{t("settings:logs.endDate")}</span>
					<Input
						aria-label={t("settings:logs.endDate")}
						type="date"
						value={endDate}
						onChange={(event) => setEndDate(event.target.value)}
					/>
				</label>
			</div>
			<div className="flex flex-wrap gap-2">
				<Button aria-label={t("settings:logs.query")} onClick={query}>
					<Search /> {t("settings:logs.query")}
				</Button>
				<Button
					aria-label={t("settings:logs.deleteFiltered")}
					disabled={!hasFilter}
					variant="destructive"
					onClick={deleteMatching}>
					<Trash2 /> {t("settings:logs.deleteFiltered")}
				</Button>
				<Button aria-label={t("settings:logs.clearAll")} variant="destructive" onClick={clearAll}>
					<Trash2 /> {t("settings:logs.clearAll")}
				</Button>
			</div>
			<div className="flex max-w-md items-end gap-2 border-t border-vscode-settings-headerBorder pt-4">
				<label className="min-w-0 flex-1 space-y-1">
					<span>{t("octocode.retentionDays")}</span>
					<Input
						aria-label={t("octocode.retentionDays")}
						min={1}
						max={3650}
						type="number"
						value={retention}
						onChange={(event) => setRetention(Number(event.target.value))}
					/>
				</label>
				<Button onClick={saveRetention}>{t("octocode.save")}</Button>
			</div>
		</section>
	)
}

export default LogsView
