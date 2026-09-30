import { getHighlighter } from "../highlighter"
import { createHighlighter } from "shiki"

vi.mock("shiki", () => ({
	bundledLanguages: { shell: {}, log: {} },
	createHighlighter: vi.fn().mockResolvedValue({ loadLanguage: vi.fn() }),
}))

it("loads only the two themes used by code and diff renderers", async () => {
	await getHighlighter("shell")
	expect(createHighlighter).toHaveBeenCalledWith({
		themes: ["github-light", "github-dark"],
		langs: ["shell", "log"],
	})
})
