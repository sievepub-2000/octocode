/**
 * Minimal JSON GET.
 *
 * The three hooks that talk to provider APIs each pulled in axios for a plain
 * authenticated GET. The webview runs in a Chromium view where `fetch` is
 * always present, so the dependency bought nothing but startup weight. This
 * keeps the one behaviour those call sites relied on: a non-2xx response is an
 * error rather than a resolved value, so their existing try/catch still works.
 */
export async function getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
	const response = await fetch(url, { headers })

	if (!response.ok) {
		throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`)
	}

	return (await response.json()) as T
}
