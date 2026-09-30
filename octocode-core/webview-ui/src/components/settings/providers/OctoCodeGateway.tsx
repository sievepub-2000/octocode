import { useEffect, useMemo } from "react"
import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	octoCodeGatewayDefaultModelId,
} from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { getOctoCodeAuthUrl } from "@src/oauth/urls"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { ModelPicker } from "../ModelPicker"
import { ApiErrorMessage } from "../ApiErrorMessage"

type OctoCodeGatewayProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

function isClaudeSonnetModelId(id: string) {
	return /claude.*sonnet/i.test(id)
}

// Exported for unit tests. Picks the default OctoCode Gateway model id, preferring
// Claude Sonnet 4.5 → Sonnet 4 → first available Sonnet → first model overall.
export function pickOctoCodeGatewayDefaultModelId(modelIds: string[]) {
	if (modelIds.length === 0) {
		return octoCodeGatewayDefaultModelId
	}

	const sonnets = modelIds.filter(isClaudeSonnetModelId)
	if (sonnets.length === 0) {
		return modelIds[0]
	}

	return (
		sonnets.find((id) => id === "anthropic/claude-sonnet-4.5") ??
		sonnets.find((id) => id.includes("claude-sonnet-4.5")) ??
		sonnets.find((id) => /sonnet-4[.-]5/i.test(id)) ??
		sonnets.find((id) => /sonnet-4(?![.-]?\d)/i.test(id)) ??
		sonnets[0]
	)
}

export const OctoCodeGateway = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: OctoCodeGatewayProps) => {
	const { t } = useAppTranslation()
	const { octoCodeIsAuthenticated, octoCodeUserEmail, octoCodeUserName, octoCodeBaseUrl, uriScheme, deviceName } =
		useExtensionState()

	const authUrl = getOctoCodeAuthUrl(uriScheme, octoCodeBaseUrl, deviceName)
	const resolvedDashboardBase = octoCodeBaseUrl?.replace(/\/$/, "") || "https://www.octocode.dev"

	const zooModels = useMemo(() => routerModels?.["octocode-gateway"] ?? {}, [routerModels])
	const modelIds = useMemo(() => Object.keys(zooModels), [zooModels])
	const resolvedDefaultModelId = useMemo(() => pickOctoCodeGatewayDefaultModelId(modelIds), [modelIds])

	useEffect(() => {
		if (modelIds.length === 0) {
			return
		}

		const current = apiConfiguration.octoCodeGatewayModelId
		if (!current || !modelIds.includes(current)) {
			setApiConfigurationField("octoCodeGatewayModelId", resolvedDefaultModelId)
		}
	}, [apiConfiguration.octoCodeGatewayModelId, modelIds, resolvedDefaultModelId, setApiConfigurationField])

	return (
		<>
			<div className="flex flex-col gap-1 rounded-md border border-vscode-panel-border p-2">
				<div className="flex items-center justify-between">
					<label className="block text-sm font-medium">{t("settings:providers.octoCodeGateway.account")}</label>
					{octoCodeIsAuthenticated && octoCodeUserEmail && (
						<span className="text-xs text-vscode-descriptionForeground">{octoCodeUserEmail}</span>
					)}
				</div>
				{!octoCodeIsAuthenticated ? (
					<div className="flex flex-col gap-1">
						<ApiErrorMessage errorMessage={t("settings:validation.octoCodeGatewaySignIn")} />
						<p className="text-xs text-vscode-descriptionForeground">
							{t("settings:providers.octoCodeGateway.signInDescription")}
						</p>
						<VSCodeButtonLink href={authUrl} appearance="primary">
							{t("settings:providers.octoCodeGateway.signInButton")}
						</VSCodeButtonLink>
					</div>
				) : (
					<div className="flex items-center gap-1">
						<span className="codicon codicon-check text-vscode-charts-green" />
						<span className="text-xs text-vscode-descriptionForeground">
							{octoCodeUserName
								? t("settings:providers.octoCodeGateway.authenticatedAs", { name: octoCodeUserName })
								: t("settings:providers.octoCodeGateway.authenticated")}
						</span>
					</div>
				)}
			</div>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={resolvedDefaultModelId}
				models={zooModels}
				modelIdKey="octoCodeGatewayModelId"
				serviceName="OctoCode Gateway"
				serviceUrl={`${resolvedDashboardBase}/dashboard/models`}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
