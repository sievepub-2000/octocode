import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"

import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { useAppTranslation } from "@src/i18n/TranslationContext"

type QwenCodeProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const QwenCode = ({ apiConfiguration, setApiConfigurationField }: QwenCodeProps) => {
	const { t } = useAppTranslation()

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.qwenCodeBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"}
				type="url"
				onInput={(event) =>
					setApiConfigurationField("qwenCodeBaseUrl", (event.target as HTMLInputElement).value)
				}
				className="w-full"
				data-testid="qwen-code-base-url">
				<label className="block font-medium mb-1">
					Qwen {t("settings:codeIndex.openAiCompatibleBaseUrlLabel")}
				</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration.qwenCodeApiKey ?? ""}
				type="password"
				onInput={(event) =>
					setApiConfigurationField("qwenCodeApiKey", (event.target as HTMLInputElement).value)
				}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full"
				data-testid="qwen-code-api-key">
				<label className="block font-medium mb-1">{t("common:ui.qwenApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.qwenCodeApiKey && (
				<VSCodeButtonLink href="https://bailian.console.aliyun.com/" appearance="secondary">
					{t("common:ui.qwenApiKey")}
				</VSCodeButtonLink>
			)}
		</>
	)
}
