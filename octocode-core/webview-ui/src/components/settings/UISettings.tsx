import { HTMLAttributes, useEffect, useMemo, useState } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { telemetryClient } from "@/utils/TelemetryClient"
import {
	type ExtensionMessage,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES_AFTER_USER_EDITED,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_NEW_FILES,
} from "@roo-code/types"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { Slider, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui"
import { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

export const CHAT_FONT_SIZE_MIN = 8
export const CHAT_FONT_SIZE_MAX = 32
export const CHAT_FONT_SIZE_DEFAULT = 13

interface UISettingsProps extends HTMLAttributes<HTMLDivElement> {
	reasoningBlockCollapsed: boolean
	enterBehavior: "send" | "newline"
	chatFontSize?: number
	autoCloseOctoCodeOpenedFiles?: boolean
	autoCloseOctoCodeOpenedFilesAfterUserEdited?: boolean
	autoCloseOctoCodeOpenedNewFiles?: boolean
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

export const UISettings = ({
	reasoningBlockCollapsed,
	enterBehavior,
	chatFontSize,
	autoCloseOctoCodeOpenedFiles,
	autoCloseOctoCodeOpenedFilesAfterUserEdited,
	autoCloseOctoCodeOpenedNewFiles,
	setCachedStateField,
	...props
}: UISettingsProps) => {
	const { t } = useAppTranslation()
	const [colorThemes, setColorThemes] = useState<ExtensionMessage["colorThemeSettings"]>()
	const [themePending, setThemePending] = useState(true)
	const [themeError, setThemeError] = useState<string>()
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type !== "colorThemeSettings") return
			setColorThemes(event.data.colorThemeSettings)
			setThemeError(event.data.error)
			setThemePending(false)
		}
		window.addEventListener("message", receive)
		vscode.postMessage({ type: "requestColorThemes" })
		return () => window.removeEventListener("message", receive)
	}, [])

	// Detect platform for dynamic modifier key display
	const primaryMod = useMemo(() => {
		const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
		return isMac ? "⌘" : "Ctrl"
	}, [])

	const handleReasoningBlockCollapsedChange = (value: boolean) => {
		setCachedStateField("reasoningBlockCollapsed", value)

		// Track telemetry event
		telemetryClient.capture("ui_settings_collapse_thinking_changed", {
			enabled: value,
		})
	}

	const handleEnterBehaviorChange = (requireCtrlEnter: boolean) => {
		const newBehavior = requireCtrlEnter ? "newline" : "send"
		setCachedStateField("enterBehavior", newBehavior)

		// Track telemetry event
		telemetryClient.capture("ui_settings_enter_behavior_changed", {
			behavior: newBehavior,
		})
	}

	const handleChatFontSizeChange = (value: number) => {
		setCachedStateField("chatFontSize", value)

		// Track telemetry event
		telemetryClient.capture("ui_settings_chat_font_size_changed", {
			value,
		})
	}

	const handleChatFontSizeReset = () => {
		setCachedStateField("chatFontSize", undefined)

		// Track telemetry event
		telemetryClient.capture("ui_settings_chat_font_size_reset")
	}

	return (
		<div {...props}>
			<SectionHeader>{t("common:ui.interface")}</SectionHeader>

			<Section>
				<div className="space-y-6">
					<SearchableSetting
						settingId="ui-color-theme"
						section="ui"
						label={t("settings:ui.colorTheme.label", { defaultValue: "Colour theme" })}>
						<div className="flex flex-col gap-1">
							<label className="font-medium" htmlFor="ui-color-theme">
								{t("common:ui.theme")}
							</label>
							<Select
								value={colorThemes?.followSystem ? "__system__" : colorThemes?.current || ""}
								disabled={themePending || !colorThemes?.themes.length}
								onValueChange={(value) => {
									setThemePending(true)
									setThemeError(undefined)
									vscode.postMessage({ type: "setColorTheme", text: value })
								}}>
								<SelectTrigger id="ui-color-theme" data-testid="color-theme-select" className="w-full">
									<SelectValue
										placeholder={
											themePending ? t("common:ui.loadingThemes") : t("common:ui.noThemes")
										}
									/>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__system__">{t("common:ui.followSystem")}</SelectItem>
									{colorThemes?.themes.map((theme) => (
										<SelectItem key={theme.id} value={theme.id}>
											{theme.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{themeError && (
								<div role="alert" className="text-vscode-errorForeground">
									{themeError}
								</div>
							)}
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("common:ui.themeDescription")}
							</div>
						</div>
					</SearchableSetting>

					{/* Collapse Thinking Messages Setting */}
					<SearchableSetting
						settingId="ui-collapse-thinking"
						section="ui"
						label={t("settings:ui.collapseThinking.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={reasoningBlockCollapsed}
								onChange={(e: any) => handleReasoningBlockCollapsedChange(e.target.checked)}
								data-testid="collapse-thinking-checkbox">
								<span className="font-medium">{t("settings:ui.collapseThinking.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.collapseThinking.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Enter Key Behavior Setting */}
					<SearchableSetting
						settingId="ui-enter-behavior"
						section="ui"
						label={t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={enterBehavior === "newline"}
								onChange={(e: any) => handleEnterBehaviorChange(e.target.checked)}
								data-testid="enter-behavior-checkbox">
								<span className="font-medium">
									{t("settings:ui.requireCtrlEnterToSend.label", { primaryMod })}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.requireCtrlEnterToSend.description", { primaryMod })}
							</div>
						</div>
					</SearchableSetting>

					{/* Chat Font Size Setting */}
					<SearchableSetting
						settingId="ui-chat-font-size"
						section="ui"
						label={t("settings:ui.chatFontSize.label")}>
						<div className="flex flex-col gap-1">
							<label className="block font-medium mb-1">{t("settings:ui.chatFontSize.label")}</label>
							<div className="flex items-center gap-2">
								<Slider
									min={CHAT_FONT_SIZE_MIN}
									max={CHAT_FONT_SIZE_MAX}
									step={1}
									value={[chatFontSize ?? CHAT_FONT_SIZE_DEFAULT]}
									onValueChange={([value]) => handleChatFontSizeChange(value)}
									data-testid="chat-font-size-slider"
								/>
								<span className="w-12 text-right">{chatFontSize ?? CHAT_FONT_SIZE_DEFAULT}px</span>
								<Button
									variant="secondary"
									size="sm"
									disabled={chatFontSize === undefined}
									onClick={handleChatFontSizeReset}
									data-testid="chat-font-size-reset">
									{t("settings:ui.chatFontSize.reset")}
								</Button>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:ui.chatFontSize.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Auto-close OctoCode opened files */}
					<SearchableSetting
						settingId="ui-auto-close-octocode-opened-files"
						section="ui"
						label={t("settings:ui.autoCloseOctoCodeOpenedFiles.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={autoCloseOctoCodeOpenedFiles ?? DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES}
								onChange={(e: any) =>
									setCachedStateField("autoCloseOctoCodeOpenedFiles", e.target.checked)
								}
								data-testid="auto-close-octocode-opened-files-checkbox">
								<span className="font-medium">
									{t("settings:ui.autoCloseOctoCodeOpenedFiles.label")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.autoCloseOctoCodeOpenedFiles.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Auto-close OctoCode opened files after user interaction */}
					<SearchableSetting
						settingId="ui-auto-close-octocode-opened-files-after-user-edited"
						section="ui"
						label={t("settings:ui.autoCloseOctoCodeOpenedFilesAfterUserEdited.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={
									autoCloseOctoCodeOpenedFilesAfterUserEdited ??
									DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES_AFTER_USER_EDITED
								}
								onChange={(e: any) =>
									setCachedStateField("autoCloseOctoCodeOpenedFilesAfterUserEdited", e.target.checked)
								}
								data-testid="auto-close-octocode-opened-files-after-user-edited-checkbox">
								<span className="font-medium">
									{t("settings:ui.autoCloseOctoCodeOpenedFilesAfterUserEdited.label")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.autoCloseOctoCodeOpenedFilesAfterUserEdited.description")}
							</div>
						</div>
					</SearchableSetting>

					{/* Auto-close OctoCode opened new files */}
					<SearchableSetting
						settingId="ui-auto-close-octocode-opened-new-files"
						section="ui"
						label={t("settings:ui.autoCloseOctoCodeOpenedNewFiles.label")}>
						<div className="flex flex-col gap-1">
							<VSCodeCheckbox
								checked={
									autoCloseOctoCodeOpenedNewFiles ?? DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_NEW_FILES
								}
								onChange={(e: any) =>
									setCachedStateField("autoCloseOctoCodeOpenedNewFiles", e.target.checked)
								}
								data-testid="auto-close-octocode-opened-new-files-checkbox">
								<span className="font-medium">
									{t("settings:ui.autoCloseOctoCodeOpenedNewFiles.label")}
								</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm ml-5 mt-1">
								{t("settings:ui.autoCloseOctoCodeOpenedNewFiles.description")}
							</div>
						</div>
					</SearchableSetting>
				</div>
			</Section>
		</div>
	)
}
