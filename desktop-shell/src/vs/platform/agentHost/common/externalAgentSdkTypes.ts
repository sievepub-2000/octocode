/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shapes this product's telemetry plumbing exchanges with an external agent CLI.
 *
 * These used to be imported from `@github/copilot-sdk`. That package — along with
 * `@anthropic-ai/claude-agent-sdk` and `@vscode/copilot-api` — was never declared
 * in any package.json and was never installed, a leftover of the original harness
 * this product was forked from. The adapters that genuinely needed those SDKs are
 * gone; only the telemetry surface below still describes data in that shape, so
 * the shape is declared here instead of imported from a package that does not
 * exist.
 *
 * Each field is taken from the code that actually constructs or reads it, not
 * from the retired package's typings.
 */

/**
 * OTel exporter settings handed to a spawned agent CLI.
 *
 * Every field is optional: pass-through mode forwards whatever the user
 * configured (which may be nothing), while loopback mode fills in only the
 * endpoint it just bound.
 */
export interface TelemetryConfig {
	/** e.g. `'otlp-http'`. Free-form because the user configures it as a string. */
	exporterType?: string;
	otlpEndpoint?: string;
	filePath?: string;
	sourceName?: string;
	captureContent?: boolean;
}

/**
 * A telemetry event forwarded from an agent CLI, awaiting routing.
 *
 * `properties` and `metrics` are structurally the `TelemetryProps` and
 * `TelemetryMeasurements` of `../node/agentHostRestrictedTelemetry.js`; they are
 * spelled out here rather than imported because `common/` must not depend on
 * `node/`.
 */
export interface GitHubTelemetryNotification {
	sessionId: string;
	/** When false the event carries no restricted data and routes unconditionally. */
	restricted: boolean;
	event: {
		/** Event name, matched against the routing table. */
		kind: string;
		/** Promoted to a `modelCallId` property when the event does not carry one. */
		model_call_id?: string;
		properties: Record<string, string | undefined>;
		metrics?: Record<string, number | undefined>;
	};
}
