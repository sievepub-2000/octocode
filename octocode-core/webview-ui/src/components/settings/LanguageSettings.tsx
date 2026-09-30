import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { LANGUAGES } from "@roo/language"
import { cn } from "@src/lib/utils"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type LanguageSettingsProps = HTMLAttributes<HTMLDivElement> & { language: string }

export const LanguageSettings = ({ language, className, ...props }: LanguageSettingsProps) => {
	const { t, languagePacks } = useAppTranslation()
	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.language")}</SectionHeader>
			<Section>
				<SearchableSetting
					settingId="language-select"
					section="language"
					label={t("settings:sections.language")}>
					<p>{LANGUAGES[language as keyof typeof LANGUAGES] ?? language}</p>
					<Button
						variant="secondary"
						data-testid="display-language-picker"
						onClick={() => vscode.postMessage({ type: "openDisplayLanguagePicker" })}>
						{t("common:ui.changeDisplayLanguage")}
					</Button>
					<p className="mt-2 text-sm text-vscode-descriptionForeground">
						{t("common:ui.displayLanguageDescription")}
					</p>
				</SearchableSetting>
				<details className="mt-4">
					<summary>{t("common:ui.supplementalTranslations")}</summary>
					<p className="my-2 text-sm text-vscode-descriptionForeground">
						{t("common:ui.supplementalDescription")}
					</p>
					<Button variant="secondary" onClick={() => vscode.postMessage({ type: "installLanguagePack" })}>
						{t("settings:language.installPack")}
					</Button>
					{languagePacks.map((pack) => (
						<div key={pack.locale} className="mt-2 flex items-center gap-2">
							<span>
								{pack.name} ({pack.locale})
							</span>
							<Button
								variant="secondary"
								onClick={() => vscode.postMessage({ type: "removeLanguagePack", text: pack.locale })}>
								{t("common:answers.remove")}
							</Button>
						</div>
					))}
				</details>
			</Section>
		</div>
	)
}
