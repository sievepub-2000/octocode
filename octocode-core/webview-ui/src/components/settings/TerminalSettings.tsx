import { useEffect, useState } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import type { ExtensionMessage } from "@roo-code/types"
import { Button } from "@/components/ui"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

export const TerminalSettings = () => {
	const { t } = useAppTranslation()
	const [inheritEnv, setInheritEnv] = useState<boolean>()
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "vsCodeSetting" && event.data.setting === "terminal.integrated.inheritEnv")
				setInheritEnv(event.data.value ?? true)
		}
		window.addEventListener("message", receive)
		vscode.postMessage({ type: "getVSCodeSetting", setting: "terminal.integrated.inheritEnv" })
		return () => window.removeEventListener("message", receive)
	}, [])
	return (
		<div className="flex flex-col">
			<SectionHeader>{t("settings:sections.terminal")}</SectionHeader>
			<Section>
				<p className="mb-3 text-sm text-vscode-descriptionForeground">{t("common:ui.terminalDescription")}</p>
				<SearchableSetting
					settingId="terminal-profile"
					section="terminal"
					label={t("settings:terminal.profile.label")}>
					<Button
						variant="secondary"
						data-testid="terminal-profile-configure-button"
						onClick={() => vscode.postMessage({ type: "openTerminalProfilePicker" })}>
						{t("settings:terminal.profile.configureButton")}
					</Button>
				</SearchableSetting>
				<SearchableSetting
					settingId="terminal-inherit-env"
					section="terminal"
					label={t("settings:terminal.inheritEnv.label")}>
					<label className="mt-3 flex items-center gap-2">
						<input
							type="checkbox"
							data-testid="terminal-inherit-env-checkbox"
							disabled={inheritEnv === undefined}
							checked={inheritEnv ?? true}
							onChange={(event) => {
								setInheritEnv(event.target.checked)
								vscode.postMessage({
									type: "updateVSCodeSetting",
									setting: "terminal.integrated.inheritEnv",
									bool: event.target.checked,
								})
							}}
						/>
						{t("settings:terminal.inheritEnv.label")}
					</label>
				</SearchableSetting>
			</Section>
		</div>
	)
}
