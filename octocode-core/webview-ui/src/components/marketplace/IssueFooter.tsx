import React from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Trans } from "react-i18next"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { EXTERNAL_LINKS } from "@/constants/externalLinks"

export const IssueFooter: React.FC = () => {
	const { t } = useAppTranslation()
	return (
		<div className="text-xs text-vscode-descriptionForeground p-3">
			<Trans i18nKey="marketplace:footer.issueText">
				<VSCodeLink href={EXTERNAL_LINKS.MARKETPLACE_ISSUE} style={{ display: "inline", fontSize: "inherit" }}>
					{t("common:ui.githubIssue")}
				</VSCodeLink>
			</Trans>
		</div>
	)
}
