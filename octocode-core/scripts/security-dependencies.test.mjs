import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(new URL("../src/package.json", import.meta.url))
const { z } = require("zod/v4")
const commonjs = require("@lmstudio/sdk")
const esm = await import("../src/node_modules/@lmstudio/sdk/dist/index.mjs")

for (const [name, sdk] of [["CommonJS", commonjs], ["ESM", esm]]) {
	test(`LM Studio ${name} preserves sparse environment maps and validates v4 tool inputs`, () => {
		assert(new sdk.LMStudioClient({ baseUrl: "ws://127.0.0.1:12345" }))
		assert.throws(() => new sdk.LMStudioClient({ baseUrl: 42 }), /baseUrl/)
		const environment = sdk.kvValueTypesLibrary.getSchema("envVars", {})
		assert(environment instanceof z.ZodType)
		assert.deepEqual(environment.parse({}), {})
		assert.deepEqual(environment.parse({ HSA_OVERRIDE_GFX_VERSION: "11.0.0" }), { HSA_OVERRIDE_GFX_VERSION: "11.0.0" })
		assert.equal(environment.safeParse({ UNKNOWN_ENV: "value" }).success, false)
		assert.equal(environment.safeParse({ HSA_OVERRIDE_GFX_VERSION: 42 }).success, false)
		const tool = sdk.tool({
			name: "owned_test",
			description: "Owned dependency boundary test",
			parameters: { values: z.array(z.string()).max(2) },
			implementation: ({ values }) => values.join(","),
		})
		assert.equal(tool.implementation({ values: ["valid"] }), "valid")
		assert.throws(() => tool.implementation({ values: Array(100_000).fill(42) }), /Failed to parse arguments/)
		assert.equal(tool.parametersSchema.safeParse({ values: Array(100_000).fill(42) }).error.issues.length, 1)
		assert(sdk.Chat.from([{ role: "user", content: "owned test" }]))
	})
}
