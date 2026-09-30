import { useEffect } from "react"

/**
 * Hook that listens for clicks on non-interactive elements and calls the provided handler.
 *
 * Interactive elements (inputs, textareas, selects, contentEditable) are excluded
 * to avoid disrupting user typing or form interactions.
 *
 * @param handler - Function to call when a non-interactive element is clicked
 */
export function useAddNonInteractiveClickListener(handler: () => void) {
	useEffect(() => {
		const handleContentClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement

			// Don't trigger for input elements to avoid disrupting typing
			if (
				!target.closest(
					'button, a, input, select, textarea, vscode-text-area, vscode-text-field, [role="button"], [contenteditable="true"]',
				)
			) {
				handler()
			}
		}

		// Add listener to the document body to handle all clicks
		document.body.addEventListener("click", handleContentClick)

		return () => {
			document.body.removeEventListener("click", handleContentClick)
		}
	}, [handler])
}
