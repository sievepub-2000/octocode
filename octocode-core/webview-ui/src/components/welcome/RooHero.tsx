import { useState } from "react"
import octocodeLogo from "../../../../src/assets/images/octocode.png?inline"

const WORDMARK_WORDS = ["OCTO", "CODE"] as const
const WORDMARK = WORDMARK_WORDS.join(" ")
const ACCENT = "#D4554F"

const RooHero = ({ showWordmark = false }: { showWordmark?: boolean }) => {
	const [isHovered, setIsHovered] = useState(false)

	return (
		<div
			className={`mb-4 relative forced-color-adjust-none group flex flex-col items-start pt-4 overflow-clip ${showWordmark ? "w-full" : "w-30"}`}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}>
			<div className="flex items-center whitespace-nowrap">
				<img
					src={octocodeLogo}
					alt="OctoCode"
					className={`z-5 object-contain translate-y-0 transition-transform duration-500 ${showWordmark ? "h-6 w-6" : "h-12 w-12"}`}
					style={{
						animation: isHovered ? "smooth-bounce 1s ease-in-out infinite" : "none",
					}}
				/>
				{showWordmark && (
					<div
						aria-label={WORDMARK}
						className="flex gap-[0.5ch]"
						style={{
							marginLeft: "24px",
							fontFamily: '"Arial Rounded MT Bold", "Trebuchet MS", ui-rounded, sans-serif',
							fontSize: "24px",
							fontWeight: 900,
							lineHeight: "24px",
						}}>
						{WORDMARK_WORDS.map((word) => (
							<span aria-hidden="true" data-testid="octocode-wordmark-word" key={word}>
								<span style={{ color: ACCENT }}>{word[0]}</span>
								{/* Theme token, not a literal: a hardcoded black wordmark
								    disappears against a dark background. */}
								<span style={{ color: "var(--vscode-foreground)" }}>{word.slice(1)}</span>
							</span>
						))}
					</div>
				)}
			</div>
			<div
				className="w-[200%] -mt-0.25 h-0.5 overflow-hidden opacity-0 group-hover:opacity-70 transition-opacity duration-300"
				data-testid="roo-hero-ground">
				<div className="w-full border-b-1 group-hover:border-b-1 border-dashed border-vscode-foreground animate-ground-slide" />
			</div>
			<div className="bg-vscode-foreground/10 rounded-full size-10 z-1 absolute -bottom-4 animate-sun opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-[2px]" />
		</div>
	)
}

export default RooHero
