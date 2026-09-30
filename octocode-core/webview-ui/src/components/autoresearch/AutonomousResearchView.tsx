import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Play, Square } from "lucide-react"

import { Button, Input } from "@/components/ui"
import { vscode } from "@src/utils/vscode"

const AutonomousResearchView = ({ onDone }: { onDone: () => void }) => {
	const { t } = useTranslation("common")
	const [objective, setObjective] = useState("")
	const [evaluator, setEvaluator] = useState("")
	const [maximumIterations, setMaximumIterations] = useState(10)
	return (
		<section className="flex h-full flex-col">
		<header className="flex items-center gap-2 border-b border-vscode-sideBar-border p-2">
			<Button aria-label={t("octocode.backToTasks")} variant="ghost" onClick={onDone}><ArrowLeft /></Button>
			<strong>{t("octocode.research")}</strong>
		</header>
		<div className="space-y-3 p-2">
			<label className="block"><span className="mb-1 block">{t("octocode.objective")}</span><Input value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
			<label className="block"><span className="mb-1 block">{t("octocode.evaluator")}</span><Input value={evaluator} onChange={(event) => setEvaluator(event.target.value)} /></label>
			<label className="block"><span className="mb-1 block">{t("octocode.maximumIterations")}</span><Input min={1} max={100} type="number" value={maximumIterations} onChange={(event) => setMaximumIterations(Number(event.target.value))} /></label>
			<div className="flex gap-2">
				<Button disabled={!objective || !evaluator} onClick={() => vscode.postMessage({ type: "startAutonomousResearch", payload: { objective, evaluator, maximumIterations } })}><Play />{t("octocode.start")}</Button>
				<Button variant="secondary" onClick={() => vscode.postMessage({ type: "stopAutonomousResearch" })}><Square />{t("octocode.stop")}</Button>
			</div>
			<p className="text-vscode-descriptionForeground">{t("octocode.researchHint")}</p>
		</div>
		</section>
	)
}

export default AutonomousResearchView
