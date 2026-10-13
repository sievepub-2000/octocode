import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Search, Trash2 } from "lucide-react"

import { Button, Input } from "@/components/ui"
import { vscode } from "@src/utils/vscode"

const PURGE_BATCH_SIZE = 10_000
const MAX_PURGE_BATCHES = 100
const RETENTION_REQUEST_TIMEOUT = 310_000

type RetentionOperation = {
	requestId: string
	phase: "setting" | "purge"
	days: number
	batches: number
	timer: number
}

const localDate = (value: string, nextDay = false) => {
	if (!value) return undefined
	if (!/^\d{4,}-\d{2}-\d{2}$/.test(value)) return null
	const [year, month, day] = value.split("-").map(Number)
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
	const date = new Date(0)
	date.setHours(0, 0, 0, 0)
	date.setFullYear(year, month - 1, day)
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
	if (nextDay) date.setDate(day + 1)
	return Number.isFinite(date.getTime()) ? date.getTime() : null
}

const LogsView = () => {
	const { t } = useTranslation(["common", "settings"])
	const [category, setCategory] = useState<"system" | "developer">("system")
	const [keyword, setKeyword] = useState("")
	const [startDate, setStartDate] = useState("")
	const [endDate, setEndDate] = useState("")
	const [retention, setRetention] = useState(30)
	const [savingRetention, setSavingRetention] = useState(false)
	const [retentionError, setRetentionError] = useState<string | null>(null)
	const [logError, setLogError] = useState<string | null>(null)
	const retentionOperation = useRef<RetentionOperation | null>(null)
	const settingRequest = useRef("")
	const refreshAfter = useRef(new Set<string>())

	const request = useCallback((method: string, params: unknown = {}) => {
		const requestId = crypto.randomUUID()
		vscode.postMessage({ type: "runtimeRequest", payload: { requestId, method, params } })
		return requestId
	}, [])

	const finishRetention = useCallback((error?: string) => {
		if (retentionOperation.current) window.clearTimeout(retentionOperation.current.timer)
		retentionOperation.current = null
		setSavingRetention(false)
		setRetentionError(error ?? null)
	}, [])
	const sendRetentionRequest = useCallback(
		(phase: RetentionOperation["phase"], days: number, batches: number) => {
			try {
				const requestId =
					phase === "setting"
						? request("setting.set", { key: "log.retention_days", value: days })
						: request("log.purge", { retention_days: days })
				const timer = window.setTimeout(() => {
					if (retentionOperation.current?.requestId === requestId) {
						finishRetention("The request timed out. Save again to retry cleanup.")
					}
				}, RETENTION_REQUEST_TIMEOUT)
				retentionOperation.current = { requestId, phase, days, batches, timer }
			} catch (error) {
				finishRetention(error instanceof Error ? error.message : String(error))
			}
		},
		[finishRetention, request],
	)

	const filter = useCallback(() => {
		const from = localDate(startDate)
		const to = localDate(endDate, true)
		if (from === null || to === null || (from !== undefined && to !== undefined && from >= to)) {
			setLogError(
				t("settings:logs.invalidDateFilter", {
					defaultValue: "Enter a supported date range with the start on or before the end.",
				}),
			)
			return null
		}
		setLogError(null)
		return {
			keyword: keyword.trim() || undefined,
			from,
			to,
		}
	}, [endDate, keyword, startDate, t])
	const query = useCallback(() => {
		const params = filter()
		if (params) request("log.list", { category, ...params, limit: 1000 })
	}, [category, filter, request])
	const selectCategory = (next: "system" | "developer") => {
		const params = filter()
		if (!params) return
		setCategory(next)
		request("log.list", { category: next, ...params, limit: 1000 })
	}
	const hasFilter = Boolean(keyword.trim() || startDate || endDate)
	const queryRef = useRef(query)
	queryRef.current = query

	useEffect(() => {
		settingRequest.current = request("setting.get", { key: "log.retention_days" })
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "runtimeResponse") return
			const { requestId, result, error } = event.data.payload ?? {}
			if (requestId === settingRequest.current) {
				settingRequest.current = ""
				if (!retentionOperation.current && Number.isInteger(result)) setRetention(result)
			}
			const operation = retentionOperation.current
			if (operation && requestId === operation.requestId) {
				window.clearTimeout(operation.timer)
				if (error) {
					finishRetention(String(error))
				} else if (operation.phase === "setting") {
					sendRetentionRequest("purge", operation.days, 0)
				} else {
					const deleted = result?.deleted_logs
					if (
						typeof deleted !== "number" ||
						!Number.isInteger(deleted) ||
						deleted < 0 ||
						deleted > PURGE_BATCH_SIZE
					) {
						finishRetention("The cleanup response was invalid. Save again to retry cleanup.")
					} else if (deleted < PURGE_BATCH_SIZE) {
						finishRetention()
						queryRef.current()
					} else if (operation.batches + 1 >= MAX_PURGE_BATCHES) {
						finishRetention(
							"Cleanup reached its batch limit. If expired logs remain, save again to continue.",
						)
					} else {
						sendRetentionRequest("purge", operation.days, operation.batches + 1)
					}
				}
			}
			if (refreshAfter.current.delete(requestId)) {
				if (error) setLogError(String(error))
				else queryRef.current()
			}
		}
		window.addEventListener("message", receive)
		return () => {
			window.removeEventListener("message", receive)
			if (retentionOperation.current) window.clearTimeout(retentionOperation.current.timer)
			retentionOperation.current = null
		}
	}, [finishRetention, request, sendRetentionRequest])

	const saveRetention = () => {
		if (retentionOperation.current) return
		const days = Math.max(1, Math.min(3650, retention || 30))
		setRetention(days)
		setRetentionError(null)
		setSavingRetention(true)
		sendRetentionRequest("setting", days, 0)
	}
	const mutateLogs = (method: string, params: unknown) => {
		setLogError(null)
		try {
			refreshAfter.current.add(request(method, params))
		} catch (error) {
			setLogError(error instanceof Error ? error.message : String(error))
		}
	}
	const deleteMatching = () => {
		const params = filter()
		if (params) mutateLogs("log.delete_matching", { category, ...params })
	}
	const clearAll = () => mutateLogs("log.clear", { category })

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
			{logError && (
				<p role="alert" className="text-vscode-errorForeground">
					{logError}
				</p>
			)}
			<div className="flex max-w-md items-end gap-2 border-t border-vscode-settings-headerBorder pt-4">
				<label className="min-w-0 flex-1 space-y-1">
					<span>{t("octocode.retentionDays")}</span>
					<Input
						aria-label={t("octocode.retentionDays")}
						min={1}
						max={3650}
						type="number"
						value={retention}
						disabled={savingRetention}
						onChange={(event) => setRetention(Number(event.target.value))}
					/>
				</label>
				<Button disabled={savingRetention} onClick={saveRetention}>
					{t("octocode.save")}
				</Button>
			</div>
			{retentionError && (
				<p role="alert" className="text-vscode-errorForeground">
					{t("settings:logs.retentionCleanupError", { defaultValue: "Retention cleanup did not finish." })}{" "}
					{retentionError}
				</p>
			)}
		</section>
	)
}

export default LogsView
