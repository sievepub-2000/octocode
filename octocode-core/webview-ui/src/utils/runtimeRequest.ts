import { vscode } from "./vscode"

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }>()

window.addEventListener("message", (event: MessageEvent) => {
	if (event.data?.type !== "runtimeResponse") return
	const response = event.data.payload as { requestId?: string; result?: unknown; error?: string }
	if (!response.requestId) return
	const request = pending.get(response.requestId)
	if (!request) return
	window.clearTimeout(request.timer)
	pending.delete(response.requestId)
	if (response.error) request.reject(new Error(response.error))
	else request.resolve(response.result)
})

export function requestRuntime<T>(method: string, params: unknown): Promise<T> {
	const requestId = crypto.randomUUID()
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			pending.delete(requestId)
			reject(new Error(`Runtime request timed out: ${method}`))
		}, 310_000)
		pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer })
		vscode.postMessage({ type: "runtimeRequest", payload: { requestId, method, params } })
	})
}
