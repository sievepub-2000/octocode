import { useEffect, useRef, useState } from "react"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { getOctoCodeAuthUrl } from "@src/oauth/urls"
import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { useTranslation } from "react-i18next"

interface OctoCodeAuthBadgeProps {
	className?: string
	/**
	 * Which edge the menu is anchored to.
	 *
	 * The badge sits in two places: the chat toolbar, at the right of the window,
	 * where the menu has to grow leftwards; and the management rail, at the very
	 * left, where the same anchoring would put it off-screen.
	 */
	align?: "left" | "right"
}

// Get proper initials from name or email
function getInitials(name?: string, email?: string): string {
	if (name) {
		const parts = name.trim().split(" ")
		if (parts.length >= 2) {
			return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
		}
		return name.slice(0, 2).toUpperCase()
	}
	if (email) {
		return email.slice(0, 2).toUpperCase()
	}
	return "?"
}

export const OctoCodeAuthBadge: React.FC<OctoCodeAuthBadgeProps> = ({ className, align = "right" }) => {
	const { t } = useTranslation("common")
	const {
		octoCodeIsAuthenticated,
		octoCodeUserName,
		octoCodeUserEmail,
		octoCodeUserImage,
		octoCodeBaseUrl,
		uriScheme,
		deviceName,
		osUserName,
	} = useExtensionState()
	const [isOpen, setIsOpen] = useState(false)
	const [imageError, setImageError] = useState(false)
	const ref = useRef<HTMLDivElement>(null)

	// Close on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setIsOpen(false)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [])

	// Reset image error when image URL changes
	useEffect(() => {
		setImageError(false)
	}, [octoCodeUserImage])

	const authUrl = getOctoCodeAuthUrl(uriScheme, octoCodeBaseUrl, deviceName)

	const showImage = octoCodeIsAuthenticated && octoCodeUserImage && !imageError

	/*
	 * Who "you" are before anyone signs in.
	 *
	 * OctoCode runs locally against a local model, so an unsigned window is not
	 * anonymous — it is the operating-system account. Showing that instead of a
	 * blank person glyph makes the entry read as an account rather than a dead
	 * button, while the OAuth surface below stays exactly as it was and takes over
	 * the moment someone signs in.
	 */
	const localName = osUserName?.trim() || ""
	const displayName = octoCodeIsAuthenticated ? octoCodeUserName : localName || undefined
	const menuItemClasses =
		"block cursor-pointer px-3.5 py-2.5 text-[13px] no-underline text-[var(--vscode-menu-foreground)] hover:bg-[var(--vscode-menu-selectionBackground)]"

	const handleSignOut = () => {
		vscode.postMessage({ type: "octoCodeSignOut" })
		setIsOpen(false)
	}

	return (
		<div ref={ref} className={cn("relative ml-2", className)}>
			{/* The icon button */}
			<button
				onClick={() => setIsOpen(!isOpen)}
				className={cn(
					"flex size-5 items-center justify-center overflow-hidden rounded-full p-0 transition-all duration-150",
					"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
					!octoCodeIsAuthenticated &&
						!localName &&
						"border border-vscode-descriptionForeground/50 bg-transparent text-vscode-descriptionForeground hover:border-vscode-descriptionForeground",
					(octoCodeIsAuthenticated || localName) &&
						!showImage &&
						"octocode-brand-fill text-[9px] font-semibold",
				)}
				title={
					octoCodeIsAuthenticated
						? `OctoCode: ${octoCodeUserEmail || t("octocode.connected")}`
						: localName || t("octocode.signIn")
				}>
				{octoCodeIsAuthenticated || localName ? (
					showImage ? (
						<img
							src={octoCodeUserImage}
							alt={t("common:ui.avatar")}
							className="size-full rounded-full object-cover"
							onError={() => setImageError(true)}
						/>
					) : (
						<span>{getInitials(displayName, octoCodeUserEmail)}</span>
					)
				) : (
					// Person icon SVG
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round">
						<circle cx="12" cy="8" r="4" />
						<path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
					</svg>
				)}
			</button>

			{/* Popover */}
			{isOpen && (
				<div
					className={cn(
						"absolute bottom-[calc(100%+8px)] z-[9999] min-w-[180px] overflow-hidden rounded-md shadow-lg",
						align === "right" ? "right-0" : "left-0",
						"border border-[var(--vscode-menu-border,var(--vscode-widget-border,#3c3c3c))]",
						"bg-[var(--vscode-menu-background)]",
					)}>
					{!octoCodeIsAuthenticated ? (
						<>
							{localName && (
								<div
									className={cn(
										"pointer-events-none select-none px-3.5 pb-1.5 pt-2 text-[11px] text-vscode-descriptionForeground",
										"border-b border-[var(--vscode-menu-separatorBackground,var(--vscode-widget-border,#3c3c3c))]",
									)}>
									{t("octocode.localAccount", { defaultValue: "Local account" })}: {localName}
								</div>
							)}
							<a href={authUrl} onClick={() => setIsOpen(false)} className={menuItemClasses}>
								{t("octocode.signIn")}
							</a>
						</>
					) : (
						<>
							{octoCodeUserEmail && (
								<div
									className={cn(
										"pointer-events-none select-none px-3.5 pb-1.5 pt-2 text-[11px] text-vscode-descriptionForeground",
										"border-b border-[var(--vscode-menu-separatorBackground,var(--vscode-widget-border,#3c3c3c))]",
									)}>
									{octoCodeUserEmail}
								</div>
							)}
							<a
								href={`${octoCodeBaseUrl || "https://www.octocode.dev"}/dashboard`}
								onClick={() => setIsOpen(false)}
								className={menuItemClasses}>
								{t("octocode.dashboard")}
							</a>
							<button
								onClick={handleSignOut}
								className={cn(
									menuItemClasses,
									"w-full border-none bg-transparent text-left text-vscode-errorForeground",
								)}>
								{t("octocode.signOut")}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	)
}
