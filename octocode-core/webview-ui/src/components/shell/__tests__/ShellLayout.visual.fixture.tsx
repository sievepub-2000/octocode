import { ArrowUpCircle, Settings, UserRound } from "lucide-react"
import { buildThemeVariables } from "@src/theme/tokens"
import { legacyDark, whiteHighContrastLight } from "@src/theme/palettes"
import { OctoCodeShell } from "../OctoCodeShell"
import "../shell.css"

const UpdateControl = ({ available }: { available: boolean }) =>
	available ? (
		<button className="octo-rail-item octo-rail-item--update" aria-label="Update">
			<ArrowUpCircle size={20} />
		</button>
	) : null

export default function ShellLayoutFixture({
	available = false,
	theme = "dark",
}: {
	available?: boolean
	theme?: "dark" | "high-contrast-light" | "high-contrast"
}) {
	return (
		<div
			className={`vscode-${theme}`}
			style={
				theme === "dark"
					? buildThemeVariables("midnight-purple")
					: theme === "high-contrast"
						? buildThemeVariables("midnight-purple", legacyDark)
						: buildThemeVariables("solarized-light", whiteHighContrastLight)
			}>
			<OctoCodeShell
				activeRailId="settings"
				onRailSelect={() => {}}
				rail={[
					{
						id: "update",
						label: "Update",
						icon: <ArrowUpCircle size={20} />,
						footer: true,
						render: <UpdateControl available={available} />,
					},
					{ id: "settings", label: "Settings", icon: <Settings size={20} />, footer: true },
					{
						id: "account",
						label: "Account",
						icon: <UserRound size={20} />,
						footer: true,
						render: (
							<button className="octo-rail-item" title="Account">
								<UserRound size={20} />
							</button>
						),
					},
				]}>
				<p>Layout fixture</p>
			</OctoCodeShell>
		</div>
	)
}
