import { useMemo } from "react"

import { StandardTooltip } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

interface ContextMeterProps {
	/** Tokens the conversation currently occupies. */
	used: number
	/** Size of the model's context window. */
	total: number
	/** Share of the window at which the conversation is condensed. */
	condenseAtPercent: number
	className?: string
}

const SIZE = 16
const CENTRE = SIZE / 2
const RADIUS = CENTRE - 1

/**
 * The wedge, drawn from twelve o'clock and sweeping clockwise.
 *
 * A filled sector rather than a ring: the quantity being shown is how much of the
 * window is *taken*, and area reads as an amount in a way an arc does not. Below
 * a full turn it is one wedge; at a full turn an arc of exactly 360° would
 * collapse to nothing, so the whole disc is drawn instead.
 */
function wedgePath(fraction: number): string {
	if (fraction >= 1) {
		return `M ${CENTRE} ${CENTRE - RADIUS} A ${RADIUS} ${RADIUS} 0 1 1 ${CENTRE - 0.01} ${CENTRE - RADIUS} Z`
	}
	const angle = fraction * 2 * Math.PI
	const x = CENTRE + RADIUS * Math.sin(angle)
	const y = CENTRE - RADIUS * Math.cos(angle)
	const largeArc = fraction > 0.5 ? 1 : 0
	return `M ${CENTRE} ${CENTRE} L ${CENTRE} ${CENTRE - RADIUS} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x} ${y} Z`
}

/**
 * How full the context window is.
 *
 * It sits beside the composer because that is where the thing it measures is
 * being spent. The colour changes only at the point where behaviour changes —
 * when the conversation is about to be condensed — so that the change carries
 * information rather than decoration.
 */
export const ContextMeter = ({ used, total, condenseAtPercent, className }: ContextMeterProps) => {
	const { t } = useAppTranslation()

	const { fraction, percent, nearThreshold } = useMemo(() => {
		const safeTotal = total > 0 ? total : 1
		const raw = Math.max(0, used) / safeTotal
		const clamped = Math.min(1, raw)
		return {
			fraction: clamped,
			percent: Math.round(clamped * 100),
			nearThreshold: clamped * 100 >= condenseAtPercent,
		}
	}, [used, total, condenseAtPercent])

	if (total <= 0) {
		return null
	}

	const label = t("chat:contextMeter.tooltip", {
		percent,
		used: used.toLocaleString(),
		total: total.toLocaleString(),
		threshold: condenseAtPercent,
		defaultValue: `Context ${percent}% (${used.toLocaleString()} / ${total.toLocaleString()} tokens). Condenses at ${condenseAtPercent}%.`,
	})

	return (
		<StandardTooltip content={label}>
			<div
				className={className}
				data-testid="context-meter"
				data-percent={percent}
				aria-label={label}
				role="img">
				<svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
					<circle
						cx={CENTRE}
						cy={CENTRE}
						r={RADIUS}
						fill="none"
						stroke="currentColor"
						strokeWidth="1"
						opacity="0.35"
					/>
					<path
						d={wedgePath(fraction)}
						fill={nearThreshold ? "var(--vscode-charts-orange, #d18616)" : "currentColor"}
						opacity={nearThreshold ? 1 : 0.7}
					/>
				</svg>
			</div>
		</StandardTooltip>
	)
}
