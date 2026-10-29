import React from "react"
import { render, screen } from "@/utils/test-utils"

import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"
import { EXTERNAL_LINKS } from "@/constants/externalLinks"

import { About } from "../About"

const installed = vi.hoisted(() => ({ desktopVersion: "2.0.4", desktopCommit: "d95203a88a", version: "0.1.16" }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => installed }))

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({
		children,
		onClick,
		disabled,
		...props
	}: React.ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
		<button onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}))

vi.mock("@/i18n/TranslationContext", () => {
	const actual = vi.importActual("@/i18n/TranslationContext")
	return {
		...actual,
		useAppTranslation: () => ({
			t: (key: string, options?: Record<string, unknown>) => {
				if (key === "settings:about.version") return `Version: ${options?.version}`
				if (key === "settings:about.versionWithSha") return `Version: ${options?.version} (${options?.sha})`
				if (!options) return key
				let result = key
				for (const [k, v] of Object.entries(options)) {
					result = result.replace(`{{${k}}}`, String(v))
				}
				return result
			},
		}),
	}
})

vi.mock("@roo/package", () => ({
	Package: {
		version: "1.0.0",
		sha: "abc12345",
	},
}))

describe("About", () => {
	const defaultProps = {
		telemetrySetting: "enabled" as const,
		setTelemetrySetting: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the About section header", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:sections.about")).toBeInTheDocument()
	})

	it("displays version information", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("Version: 2.0.4 (d95203a8)")).toBeInTheDocument()
	})

	it("renders the bug report section with label and link text", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:about.bugReport.label")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "settings:about.bugReport.link" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.BUG_REPORT,
		)
	})

	it("renders the feature request section with label and link text", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:about.featureRequest.label")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "settings:about.featureRequest.link" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.FEATURE_REQUEST,
		)
	})

	it("renders the security issue section with label and link text", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:about.securityIssue.label")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "settings:about.securityIssue.link" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.SECURITY_POLICY,
		)
	})

	it("renders export, import, and reset buttons", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:footer.settings.export")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.import")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.reset")).toBeInTheDocument()
	})
})
