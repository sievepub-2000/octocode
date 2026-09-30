import { createValidationSchema } from "../CodeIndexPopover"

const t = (key: string) => key

describe("CodeIndexPopover validation", () => {
	it("allows disabling indexing without provider configuration", () => {
		const result = createValidationSchema("openai", t).safeParse({
			codebaseIndexEnabled: false,
			codebaseIndexQdrantUrl: "",
			codeIndexOpenAiKey: "",
			codebaseIndexEmbedderModelId: "",
		})

		expect(result.success).toBe(true)
	})
})
