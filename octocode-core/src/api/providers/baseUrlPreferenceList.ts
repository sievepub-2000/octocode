/**
 * A base URL may be written as a comma-separated preference list, e.g.
 * `http://2.2.2.2:8000/v1,http://192.168.10.4:8000/v1` — the same server reachable
 * over a cable and over Wi-Fi. `octocode-host`'s `endpoint.rs` probes the list and
 * uses the first endpoint that answers; the extension has no probe of its own, so
 * it takes the first entry and, where it can retry (model listing), walks the list.
 *
 * Anything without a comma passes through unchanged, so ordinary URLs are
 * unaffected.
 */

export function parseBaseUrlPreferenceList(value: string | undefined): string[] {
	if (!value) {
		return []
	}

	return value
		.split(",")
		.map((entry) => entry.trim().replace(/\/+$/, ""))
		.filter((entry) => entry.length > 0)
}

/** The entry the extension talks to when it cannot probe: the first one listed. */
export function primaryBaseUrl(value: string | undefined): string | undefined {
	return parseBaseUrlPreferenceList(value)[0]
}
