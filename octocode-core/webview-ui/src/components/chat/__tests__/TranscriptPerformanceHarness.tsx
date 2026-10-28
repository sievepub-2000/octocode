import { Profiler, type ComponentProps, type ProfilerOnRenderCallback } from "react"
import RuntimeTranscript from "../RuntimeTranscript"
import { TooltipProvider } from "../../ui/tooltip"

type Props = ComponentProps<typeof RuntimeTranscript> & {
	onRender?: ProfilerOnRenderCallback
	withInput?: boolean
	height?: number
}

const observe = () => {}

export default function TranscriptPerformanceHarness({
	onRender = observe,
	withInput = true,
	height = 760,
	...props
}: Props) {
	return (
		<TooltipProvider>
			<div style={{ display: "flex", flexDirection: "column", height }}>
				<Profiler id="transcript" onRender={onRender}>
					<RuntimeTranscript {...props} />
				</Profiler>
				{withInput && <textarea aria-label="Performance input" style={{ height: 56, flexShrink: 0 }} />}
			</div>
		</TooltipProvider>
	)
}
