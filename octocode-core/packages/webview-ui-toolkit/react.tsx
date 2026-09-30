import React, {
	Children,
	createContext,
	forwardRef,
	isValidElement,
	useContext,
	useId,
	useMemo,
	useState,
} from "react"

type Appearance = "primary" | "secondary" | "icon" | "icon-label"

export const VSCodeButton = forwardRef<
	HTMLButtonElement,
	React.ComponentPropsWithoutRef<"button"> & { appearance?: Appearance }
>(({ appearance = "primary", className = "", type = "button", ...props }, ref) => (
	<button
		ref={ref}
		type={type}
		className={`octo-vscode-button octo-vscode-button-${appearance} ${className}`.trim()}
		{...props}
	/>
))
VSCodeButton.displayName = "VSCodeButton"

export const VSCodeLink = forwardRef<HTMLAnchorElement, React.ComponentPropsWithoutRef<"a">>(
	({ className = "", ...props }, ref) => (
		<a ref={ref} className={`octo-vscode-link ${className}`.trim()} {...props} />
	),
)
VSCodeLink.displayName = "VSCodeLink"

export const VSCodeBadge = forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<"span">>(
	({ className = "", ...props }, ref) => (
		<span ref={ref} className={`octo-vscode-badge ${className}`.trim()} {...props} />
	),
)
VSCodeBadge.displayName = "VSCodeBadge"

export const VSCodeProgressRing = forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<"span">>(
	({ className = "", ...props }, ref) => (
		<span ref={ref} role="progressbar" className={`octo-vscode-progress ${className}`.trim()} {...props} />
	),
)
VSCodeProgressRing.displayName = "VSCodeProgressRing"

type TextFieldProps = Omit<React.ComponentPropsWithoutRef<"input">, "children"> & {
	children?: React.ReactNode
	"data-testid"?: string
}

export const VSCodeTextField = forwardRef<HTMLInputElement, TextFieldProps>(
	({ children, className = "", id, style, ...props }, ref) => {
		const generatedId = useId()
		if (!children) {
			return <input ref={ref} id={id} className={`octo-vscode-input ${className}`.trim()} style={style} {...props} />
		}

		const inputId = id ?? generatedId
		const items = Children.toArray(children)
		const elements = items.filter(isValidElement) as React.ReactElement<{ htmlFor?: string; slot?: string }>[]
		const labels = elements.filter((item) => item.type === "label")
		const start = elements.filter((item) => item.props.slot === "start")
		const end = elements.filter((item) => item.props.slot === "end")
		const claimed = new Set<React.ReactNode>([...labels, ...start, ...end])
		const other = items.filter((item) => !claimed.has(item))

		return (
			<div className={`octo-vscode-field ${className}`.trim()}>
				{labels.map((label) => React.cloneElement(label, { htmlFor: inputId }))}
				{other}
				<div className="octo-vscode-input-wrap">
					{start}
					<input
						ref={ref}
						id={inputId}
						className="octo-vscode-input"
						style={{
							...style,
							paddingLeft: start.length ? 28 : style?.paddingLeft,
							paddingRight: end.length ? 28 : style?.paddingRight,
						}}
						{...props}
					/>
					{end}
				</div>
			</div>
		)
	},
)
VSCodeTextField.displayName = "VSCodeTextField"

type TextAreaProps = React.ComponentPropsWithoutRef<"textarea"> & {
	"data-testid"?: string
	resize?: React.CSSProperties["resize"]
}

export const VSCodeTextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
	({ className = "", resize, style, ...props }, ref) => (
		<textarea ref={ref} className={`octo-vscode-input ${className}`.trim()} style={{ ...style, resize }} {...props} />
	),
)
VSCodeTextArea.displayName = "VSCodeTextArea"

export const VSCodeCheckbox = forwardRef<
	HTMLInputElement,
	Omit<React.ComponentPropsWithoutRef<"input">, "type"> & { children?: React.ReactNode }
>(({ children, className = "", ...props }, ref) => (
	<label className={`octo-vscode-check ${className}`.trim()}>
		<input ref={ref} type="checkbox" {...props} />
		<span>{children}</span>
	</label>
))
VSCodeCheckbox.displayName = "VSCodeCheckbox"

export const VSCodeDropdown = forwardRef<HTMLSelectElement, React.ComponentPropsWithoutRef<"select">>(
	({ className = "", ...props }, ref) => (
		<select ref={ref} className={`octo-vscode-input ${className}`.trim()} {...props} />
	),
)
VSCodeDropdown.displayName = "VSCodeDropdown"

export const VSCodeOption = forwardRef<HTMLOptionElement, React.ComponentPropsWithoutRef<"option">>(
	(props, ref) => <option ref={ref} {...props} />,
)
VSCodeOption.displayName = "VSCodeOption"

type RadioContextValue = {
	name: string
	value?: string
	onChange?: React.FormEventHandler<HTMLElement>
}
const RadioContext = createContext<RadioContextValue | undefined>(undefined)

export function VSCodeRadioGroup({
	value,
	onChange,
	children,
	className = "",
}: {
	value?: string
	onChange?: React.FormEventHandler<HTMLElement>
	children?: React.ReactNode
	className?: string
}) {
	const name = useId()
	const context = useMemo(() => ({ name, value, onChange }), [name, onChange, value])
	return (
		<RadioContext.Provider value={context}>
			<div role="radiogroup" className={className}>
				{children}
			</div>
		</RadioContext.Provider>
	)
}

export const VSCodeRadio = forwardRef<
	HTMLInputElement,
	Omit<React.ComponentPropsWithoutRef<"input">, "type" | "name" | "checked"> & { value: string }
>(({ children, value, className = "", ...props }, ref) => {
	const group = useContext(RadioContext)
	return (
		<label className={`octo-vscode-check ${className}`.trim()}>
			<input
				ref={ref}
				type="radio"
				name={group?.name}
				value={value}
				checked={group?.value === value}
				onChange={group?.onChange}
				{...props}
			/>
			<span>{children}</span>
		</label>
	)
})
VSCodeRadio.displayName = "VSCodeRadio"

type PanelProps = React.ComponentPropsWithoutRef<"div">
type TabProps = React.ComponentPropsWithoutRef<"button">

export function VSCodePanelTab(props: TabProps) {
	return <button type="button" role="tab" {...props} />
}

export function VSCodePanelView(props: PanelProps) {
	return <div role="tabpanel" {...props} />
}

export function VSCodePanels({ children, className = "", ...props }: PanelProps) {
	const items = Children.toArray(children)
	const tabs = items.filter((item): item is React.ReactElement<TabProps> => isValidElement(item) && item.type === VSCodePanelTab)
	const views = items.filter(
		(item): item is React.ReactElement<PanelProps> => isValidElement(item) && item.type === VSCodePanelView,
	)
	const [active, setActive] = useState(() => tabs[0]?.props.id ?? "")
	const index = Math.max(
		0,
		tabs.findIndex((tab) => tab.props.id === active),
	)
	return (
		<div className={`octo-vscode-panels ${className}`.trim()} {...props}>
			<div role="tablist" className="octo-vscode-tablist">
				{tabs.map((tab) => (
					<button
						key={tab.props.id}
						type="button"
						role="tab"
						aria-selected={tab.props.id === active}
						onClick={() => setActive(tab.props.id ?? "")}>
						{tab.props.children}
					</button>
				))}
			</div>
			{views[index]}
		</div>
	)
}
