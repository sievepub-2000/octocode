import { useMemo, useState } from "react"
import { Brain } from "lucide-react"

import {
	detectThinking,
	resolveThinkingTier,
	type ModelInfo,
	type ProviderSettings,
	type ReasoningEffortSetting,
} from "@roo-code/types"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface ThinkingTierPickerProps {
	apiConfiguration?: ProviderSettings
	modelId?: string
	modelInfo?: ModelInfo
	disabled?: boolean
	/** Persist the tier on the current profile. */
	onChange: (settings: Pick<ProviderSettings, "reasoningEffort" | "enableReasoningEffort" | "reasoningStyle">) => void
}

/**
 * Thinking tier next to the model name, like Claude Code's effort picker.
 * The offered tiers come from the selected model; a model without a thinking mode
 * shows the control greyed out.
 */
export const ThinkingTierPicker = ({ apiConfiguration, modelId, modelInfo, disabled, onChange }: ThinkingTierPickerProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const capability = useMemo(() => detectThinking(modelId, modelInfo), [modelId, modelInfo])
	const saved =
		apiConfiguration?.enableReasoningEffort === false ? "disable" : apiConfiguration?.reasoningEffort
	const tier = resolveThinkingTier(capability, saved)
	const supported = !!capability.style && capability.tiers.length > 0
	const label = (value: ReasoningEffortSetting) => t(`chat:thinking.tiers.${value}`)
	const title = supported ? t("chat:thinking.title", { tier: tier ? label(tier) : "" }) : t("chat:thinking.unsupported")

	const select = (value: ReasoningEffortSetting) => {
		onChange({ reasoningEffort: value, enableReasoningEffort: value !== "disable", reasoningStyle: capability.style })
		setOpen(false)
	}

	const trigger = (
		<button
			type="button"
			aria-label={title}
			aria-disabled={!supported || disabled}
			data-testid="thinking-tier-trigger"
			disabled={!supported || disabled}
			className={cn(
				"inline-flex h-7 min-w-[28px] items-center gap-1 rounded-md border-none bg-transparent px-1.5 text-xs",
				"text-vscode-descriptionForeground focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
				supported && !disabled
					? "cursor-pointer hover:bg-[rgba(255,255,255,0.03)] hover:text-vscode-foreground"
					: "cursor-not-allowed opacity-40",
			)}>
			<Brain className="h-3.5 w-3.5 shrink-0" />
			{supported && tier ? <span className="whitespace-nowrap">{label(tier)}</span> : null}
		</button>
	)

	if (!supported || disabled) return <StandardTooltip content={title}>{trigger}</StandardTooltip>

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<StandardTooltip content={title}>
				<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent align="end" sideOffset={6} container={portalContainer} className="w-44 p-1">
				<div className="px-2 py-1 text-xs text-vscode-descriptionForeground">{t("chat:thinking.heading")}</div>
				{capability.tiers.map((value) => (
					<button
						key={value}
						type="button"
						role="menuitemradio"
						aria-checked={value === tier}
						data-testid={`thinking-tier-${value}`}
						onClick={() => select(value)}
						className={cn(
							"flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm",
							"hover:bg-vscode-list-hoverBackground",
							value === tier && "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
						)}>
						<span>{label(value)}</span>
						{value === tier ? <span aria-hidden>✓</span> : null}
					</button>
				))}
			</PopoverContent>
		</Popover>
	)
}
