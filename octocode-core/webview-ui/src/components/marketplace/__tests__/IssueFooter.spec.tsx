import React from "react"
import { render, screen } from "@/utils/test-utils"
import { loadUiLanguage, WithTranslations } from "@src/utils/test-i18n"

import { EXTERNAL_LINKS } from "@/constants/externalLinks"

import { IssueFooter } from "../IssueFooter"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("IssueFooter", () => {
	beforeAll(() => loadUiLanguage())

	it("links marketplace issue reporting to the OctoCode repository", () => {
		/*
		 * Wrapped so the translation context actually translates.
		 *
		 * `useAppTranslation` hands back the key unchanged when nothing provides
		 * it, which is what left this looking for text the DOM never contained.
		 */
		render(
			<WithTranslations>
				<IssueFooter />
			</WithTranslations>,
		)

		expect(screen.getByRole("link", { name: "提交 GitHub 问题" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.MARKETPLACE_ISSUE,
		)
	})
})
