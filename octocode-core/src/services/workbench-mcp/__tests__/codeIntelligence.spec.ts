import { describe, expect, it } from "vitest"

import {
	CODE_INTELLIGENCE_ACTIONS,
	dispatchCodeIntelligence,
	rawLspCommand,
	validateCodeIntelligenceRequest,
} from "../codeIntelligence"

describe("CodeIntelligence public contract", () => {
	it("publishes the 14 OMP-derived actions once", () => {
		expect(CODE_INTELLIGENCE_ACTIONS).toHaveLength(14)
		expect(new Set(CODE_INTELLIGENCE_ACTIONS).size).toBe(14)
	})

	it("allows only read-only VS Code language-provider raw requests", () => {
		expect(rawLspCommand("vscode.executeDefinitionProvider")).toBe("vscode.executeDefinitionProvider")
		expect(() => rawLspCommand("workbench.action.reloadWindow")).toThrow("Raw language request is not allowed")
		expect(() => rawLspCommand("octocode.deleteEverything")).toThrow("Raw language request is not allowed")
	})

	it("validates action-specific required fields at the adapter boundary", () => {
		expect(validateCodeIntelligenceRequest({ action: "symbols", query: "Host" })).toEqual({
			action: "symbols",
			query: "Host",
		})
		expect(() => validateCodeIntelligenceRequest({ action: "definition", path: "a.ts" })).toThrow("line and column")
		expect(() => validateCodeIntelligenceRequest({ action: "rename", path: "a.ts", line: 1, column: 1 })).toThrow(
			"newName",
		)
		expect(() =>
			validateCodeIntelligenceRequest({ action: "request", command: "workbench.action.reloadWindow" }),
		).toThrow("not allowed")
	})

	it("requires full permission for code-intelligence writes", async () => {
		await expect(
			dispatchCodeIntelligence(
				{ action: "rename", path: "a.ts", line: 1, column: 1, newName: "b" },
				{ taskId: "task", sessionId: "session", permissionProfile: "review" },
			),
		).rejects.toThrow("permission profile does not allow write")
	})
})
