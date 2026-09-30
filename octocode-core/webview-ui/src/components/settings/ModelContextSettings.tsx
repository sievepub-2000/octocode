import { useEffect, useState } from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import type { ProviderSettings } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"

type ContextResult = {
	contextWindow: number
	source: string
	maxOutputTokens: number
	percent: number
	triggerTokens: number
	warning?: string
}

export function ModelContextSettings({
	settings,
	onChange,
}: {
	settings: ProviderSettings
	onChange: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
}) {
	const { t } = useAppTranslation()
	const [result, setResult] = useState<ContextResult>()
	const [error, setError] = useState("")
	const [manualValue, setManualValue] = useState(String(settings.modelContextWindow ?? 131072))
	useEffect(() => setManualValue(String(settings.modelContextWindow ?? 131072)), [settings.modelContextWindow])
	useEffect(() => {
		const requestId = crypto.randomUUID()
		setResult(undefined)
		setError("")
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "runtimeResponse" || event.data.payload?.requestId !== requestId) return
			clearTimeout(timeout)
			if (event.data.payload.error) setError(String(event.data.payload.error))
			else setResult(event.data.payload.result)
		}
		window.addEventListener("message", receive)
		const debounce = setTimeout(
			() =>
				vscode.postMessage({
					type: "runtimeRequest",
					payload: { method: "provider.context", params: settings, requestId },
				}),
			600,
		)
		const timeout = setTimeout(() => setError(t("common:ui.contextTimeout")), 12_000)
		return () => {
			clearTimeout(debounce)
			clearTimeout(timeout)
			window.removeEventListener("message", receive)
		}
	}, [settings, t])
	return (
		<fieldset className="space-y-2 border-t border-vscode-panel-border pt-3" data-testid="model-context-settings">
			<legend className="font-semibold">{t("common:ui.contextSettings")}</legend>
			{(settings.apiProvider === "openai" || settings.apiProvider === "openai-native") && (
				<label className="flex items-center justify-between gap-2">
					{t("common:ui.requestProtocol")}
					<select
						aria-label={t("common:ui.requestProtocol")}
						value={settings.apiFormat ?? "auto"}
						onChange={(event) =>
							onChange(
								"apiFormat",
								event.target.value === "auto"
									? undefined
									: (event.target.value as ProviderSettings["apiFormat"]),
							)
						}
						className="bg-vscode-input-background text-vscode-input-foreground">
						<option value="auto">{t("common:ui.automatic")}</option>
						<option value="chat_completions">Chat Completions</option>
						<option value="responses">Responses</option>
						<option value="messages">Messages</option>
					</select>
				</label>
			)}
			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					checked={settings.autoContextWindow !== false}
					onChange={(event) => onChange("autoContextWindow", event.target.checked)}
				/>
				{t("common:ui.detectContext")}
			</label>
			{settings.autoContextWindow === false && (
				<label className="flex items-center justify-between gap-2">
					{t("common:ui.manualContext")}
					<input
						aria-label={t("common:ui.manualContext")}
						type="number"
						min={4096}
						max={100000000}
						value={manualValue}
						onBlur={() => setManualValue(String(settings.modelContextWindow ?? 131072))}
						onChange={(event) => {
							setManualValue(event.target.value)
							const value = event.target.valueAsNumber
							if (Number.isSafeInteger(value) && value >= 4096 && value <= 100000000)
								onChange("modelContextWindow", value)
						}}
						className="w-32 bg-vscode-input-background text-vscode-input-foreground"
					/>
				</label>
			)}
			<p className="text-sm text-vscode-descriptionForeground" role="status">
				{result
					? t("common:ui.effectiveContext", {
							context: result.contextWindow,
							source:
								(
									{
										server: t("common:ui.serverDetected"),
										configuration: t("common:ui.manualConfiguration"),
										catalog: t("common:ui.providerMetadata"),
										fallback: t("common:ui.defaultFallback"),
									} as Record<string, string>
								)[result.source] ?? result.source,
							output: result.maxOutputTokens,
							compaction:
								result.percent === 0
									? t("common:ui.compactionDisabled")
									: t("common:ui.compactionTrigger", {
											percent: result.percent,
											tokens: result.triggerTokens,
										}),
						})
					: error || t("common:ui.detectingContext")}
			</p>
			{result?.warning && <p className="text-sm text-vscode-descriptionForeground">{result.warning}</p>}
			<p className="text-xs text-vscode-descriptionForeground">{t("common:ui.contextDescription")}</p>
		</fieldset>
	)
}
