/** Render only persisted event time; undated history must stay undated. */
export default function MessageTimestamp({ timestamp }: { timestamp?: number }) {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null
	const date = new Date(timestamp)
	if (!Number.isFinite(date.getTime())) return null
	const pad = (value: number) => String(value).padStart(2, "0")
	const local = `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	return (
		<time
			className="my-2 block w-full text-center text-xs text-vscode-descriptionForeground"
			dateTime={date.toISOString()}>
			{`--${local}--`}
		</time>
	)
}
