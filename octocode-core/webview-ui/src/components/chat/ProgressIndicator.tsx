import { VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react"

export const ProgressIndicator = () => (
	<div
		aria-hidden="true"
		data-testid="progress-indicator"
		style={{
			width: "16px",
			height: "16px",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
		}}>
		<div style={{ transform: "scale(0.55)", transformOrigin: "center" }}>
			<VSCodeProgressRing />
		</div>
	</div>
)
