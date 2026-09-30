// npx vitest src/components/settings/__tests__/ContextManagementSettings.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"
import { ContextManagementSettings } from "../ContextManagementSettings"
import { vscode } from "@/utils/vscode"

// Mock the translation hook
vi.mock("@/hooks/useAppTranslation", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			// Return specific translations for our test cases
			if (key === "settings:contextManagement.diagnostics.maxMessages.unlimitedLabel") {
				return "Unlimited"
			}
			return key
		},
	}),
}))

// Mock the UI components
vi.mock("@/components/ui", () => ({
	...vi.importActual("@/components/ui"),
	Slider: ({ value, onValueChange, "data-testid": dataTestId, disabled, min, max }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			min={min}
			max={max}
			onChange={(e) => onValueChange([parseFloat(e.target.value)])}
			onKeyDown={(e) => {
				const currentValue = value?.[0] ?? 0
				if (e.key === "ArrowRight") {
					onValueChange([currentValue + 1])
				} else if (e.key === "ArrowLeft") {
					onValueChange([currentValue - 1])
				}
			}}
			data-testid={dataTestId}
			disabled={disabled}
			role="slider"
		/>
	),
	Input: ({ value, onChange, "data-testid": dataTestId, ...props }: any) => (
		<input value={value} onChange={onChange} data-testid={dataTestId} {...props} />
	),
	Button: ({ children, onClick, ...props }: any) => (
		<button onClick={onClick} {...props}>
			{children}
		</button>
	),
	Select: ({ children, value, onValueChange, ...props }: any) => (
		<div role="combobox" data-value={value} {...props}>
			{/* Hidden trigger lets tests drive profile selection deterministically:
			    set data-next-value on the button, then click it. */}
			<button
				type="button"
				aria-hidden="true"
				data-testid="threshold-profile-change"
				onClick={(e: any) => onValueChange?.(e.currentTarget.getAttribute("data-next-value"))}
			/>
			{children}
		</div>
	),
	SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectValue: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
}))

// Mock vscode utilities - this is necessary since we're not in a VSCode environment

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock VSCode components to behave like standard HTML elements
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children, "data-testid": dataTestId, ...props }: any) => (
		<label data-testid={dataTestId} {...props}>
			<input
				type="checkbox"
				role="checkbox"
				checked={checked || false}
				aria-checked={checked || false}
				onChange={(e: any) => onChange?.({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
	VSCodeTextArea: ({ value, onChange, ...props }: any) => <textarea value={value} onChange={onChange} {...props} />,
}))

describe("ContextManagementSettings", () => {
	const defaultProps = {
		autoCondenseContext: false,
		autoCondenseContextPercent: 80,
		listApiConfigMeta: [],
		showRooIgnoredFiles: false,
		profileThresholds: {},
		setCachedStateField: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders with autoCondenseContext enabled", () => {
		const propsWithAutoCondense = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
		}
		render(<ContextManagementSettings {...propsWithAutoCondense} />)

		// Should render the auto condense section
		const autoCondenseCheckbox = screen.getByTestId("auto-condense-context-checkbox")
		expect(autoCondenseCheckbox).toBeInTheDocument()

		// Should render the threshold slider with correct value
		const slider = screen.getByTestId("condense-threshold-slider")
		expect(slider).toBeInTheDocument()

		// Should render the profile select dropdown
		const selects = screen.getAllByRole("combobox")
		expect(selects).toHaveLength(1)
	})

	describe("Auto Condense Context functionality", () => {
		const autoCondenseProps = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
			listApiConfigMeta: [
				{ id: "config-1", name: "Config 1" },
				{ id: "config-2", name: "Config 2" },
			],
		}

		it("toggles auto condense context setting", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			const checkbox = screen.getByTestId("auto-condense-context-checkbox")
			const input = checkbox.querySelector('input[type="checkbox"]')
			expect(input).toBeChecked()

			// Toggle off
			fireEvent.click(checkbox)
			expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContext", false)
		})

		it("shows threshold settings when auto condense is enabled", () => {
			render(<ContextManagementSettings {...autoCondenseProps} />)

			// Threshold settings should be visible
			expect(screen.getByTestId("condense-threshold-slider")).toBeInTheDocument()
			// One combobox for profile selection
			expect(screen.getAllByRole("combobox")).toHaveLength(1)
		})

		it("updates auto condense context percent", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			// Find the condense threshold slider
			const slider = screen.getByTestId("condense-threshold-slider")

			// Test slider interaction
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContextPercent", 76)
		})

		it("displays correct auto condense context percent value", () => {
			render(<ContextManagementSettings {...autoCondenseProps} />)
			expect(screen.getByText("75%")).toBeInTheDocument()
		})

		// Case 4: profileThresholds must buffer through cachedState, not persist before Save.
		it("buffers profile threshold changes without persisting before Save", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			// Select a non-default profile so the slider edits profileThresholds.
			const profileTrigger = screen.getByTestId("threshold-profile-change")
			profileTrigger.setAttribute("data-next-value", "config-1")
			fireEvent.click(profileTrigger)

			// Move the threshold slider for that profile.
			const slider = screen.getByTestId("condense-threshold-slider")
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(mockSetCachedStateField).toHaveBeenCalledWith("profileThresholds", { "config-1": 76 })
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		})
	})

	it("retains attachment limits and removes inactive engine controls", () => {
		render(<ContextManagementSettings {...defaultProps} />)
		expect(screen.queryByTestId("condense-prompt-textarea")).not.toBeInTheDocument()
		expect(screen.queryByTestId("open-tabs-limit-slider")).not.toBeInTheDocument()
		expect(screen.queryByTestId("write-delay-slider")).not.toBeInTheDocument()
		fireEvent.change(screen.getByTestId("max-image-file-size-input"), { target: { value: "6" } })
		expect(defaultProps.setCachedStateField).toHaveBeenLastCalledWith("maxImageFileSize", 6)
	})
})
