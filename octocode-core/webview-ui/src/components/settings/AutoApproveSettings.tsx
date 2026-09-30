import type { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

export const AutoApproveSettings = (props: HTMLAttributes<HTMLDivElement>) => {
	const { t } = useAppTranslation()
	const { permissionProfile = "full" } = useExtensionState()
	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.autoApprove")}</SectionHeader>
			<Section>
				<SearchableSetting
					settingId="permission-profile"
					section="autoApprove"
					label={t("settings:autoApprove.profile.label")}>
					<label className="block">
						<span className="mb-1 block font-medium">{t("settings:autoApprove.profile.label")}</span>
						<select
							aria-label={t("settings:autoApprove.profile.label")}
							className="h-8 w-full rounded border border-vscode-dropdown-border bg-vscode-dropdown-background px-2"
							value={permissionProfile}
							onChange={(event) =>
								vscode.postMessage({ type: "permissionProfile", text: event.target.value })
							}>
							<option value="review">{t("settings:autoApprove.profile.review")}</option>
							<option value="directory">{t("settings:autoApprove.profile.directory")}</option>
							<option value="full">{t("settings:autoApprove.profile.full")}</option>
						</select>
					</label>
				</SearchableSetting>
				<p className="mt-3 text-sm text-vscode-descriptionForeground">{t("common:ui.permissionTiming")}</p>
			</Section>
		</div>
	)
}
