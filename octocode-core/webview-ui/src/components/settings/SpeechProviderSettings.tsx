import { useEffect, useState } from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import type { ProviderSettings } from "@roo-code/types"
import { requestRuntime } from "@src/utils/runtimeRequest"

export function SpeechProviderSettings({
	settings,
	onChange,
}: {
	settings: ProviderSettings
	onChange: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
}) {
	const { t } = useAppTranslation()
	const [directory, setDirectory] = useState("")
	const [status, setStatus] = useState("")
	const [checking, setChecking] = useState(false)
	const local = settings.speechProvider !== "openai-compatible"
	useEffect(() => {
		let active = true
		setStatus("")
		void requestRuntime<{ modelDirectory: string }>("provider.speech.info", settings)
			.then((result) => {
				if (active) setDirectory(result.modelDirectory)
			})
			.catch((error) => {
				if (active) setStatus(String(error))
			})
		return () => {
			active = false
		}
	}, [settings])
	return (
		<fieldset className="space-y-2 border-t border-vscode-panel-border pt-3" data-testid="speech-provider-settings">
			<legend className="font-semibold">{t("common:ui.speechProvider")}</legend>
			<label className="block">
				{t("common:ui.speechService")}
				<select
					aria-label={t("common:ui.speechService")}
					className="w-full bg-vscode-input-background text-vscode-input-foreground"
					value={settings.speechProvider ?? "funasr-local"}
					onChange={(event) =>
						onChange("speechProvider", event.target.value as ProviderSettings["speechProvider"])
					}>
					<option value="funasr-local">{t("common:ui.localSpeech")}</option>
					<option value="openai-compatible">{t("common:ui.httpSpeech")}</option>
				</select>
			</label>
			{local ? (
				<label className="block">
					{t("common:ui.modelDirectory")}
					<input
						aria-label={t("common:ui.speechModelDirectory")}
						className="w-full bg-vscode-input-background text-vscode-input-foreground"
						value={settings.speechModelDirectory ?? ""}
						placeholder={directory}
						onChange={(event) => onChange("speechModelDirectory", event.target.value)}
					/>
				</label>
			) : (
				<>
					<label className="block">
						{t("common:ui.endpoint")}
						<input
							aria-label={t("common:ui.speechEndpoint")}
							className="w-full bg-vscode-input-background text-vscode-input-foreground"
							value={settings.speechBaseUrl ?? ""}
							placeholder="http://127.0.0.1:8178/v1"
							onChange={(event) => onChange("speechBaseUrl", event.target.value)}
						/>
					</label>
					<label className="block">
						{t("common:ui.apiKey")}
						<input
							aria-label={t("common:ui.speechApiKey")}
							type="password"
							autoComplete="off"
							className="w-full bg-vscode-input-background text-vscode-input-foreground"
							value={settings.speechApiKey ?? ""}
							onChange={(event) => onChange("speechApiKey", event.target.value)}
						/>
					</label>
				</>
			)}
			<label className="block">
				{local ? t("common:ui.modelFileName") : t("common:ui.modelName")}
				<input
					aria-label={t("common:ui.speechModelName")}
					className="w-full bg-vscode-input-background text-vscode-input-foreground"
					value={settings.speechModelId ?? ""}
					placeholder={local ? "sensevoice-small-q8.gguf" : t("common:ui.speechModelId")}
					onChange={(event) => onChange("speechModelId", event.target.value)}
				/>
			</label>
			<button
				type="button"
				disabled={checking}
				className="rounded px-2 py-1 bg-vscode-button-background text-vscode-button-foreground"
				onClick={async () => {
					setChecking(true)
					setStatus("")
					try {
						await requestRuntime("provider.speech.check", settings)
						setStatus(t("common:ui.speechConnected"))
					} catch (error) {
						setStatus(error instanceof Error ? error.message : String(error))
					} finally {
						setChecking(false)
					}
				}}>
				{checking ? t("common:ui.checking") : t("common:ui.checkSpeech")}
			</button>
			<p role="status" className="text-sm text-vscode-descriptionForeground">
				{status}
			</p>
			<p className="text-xs text-vscode-descriptionForeground">{t("common:ui.speechDescription")}</p>
		</fieldset>
	)
}
