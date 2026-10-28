import config from "./playwright-ct.config"

export default {
	...config,
	testMatch: "**/RuntimeTranscript.performance.visual.tsx",
	outputDir: "test-results/performance",
	reporter: [["list"]],
	workers: 1,
	use: { ...config.use, ctCacheDir: "playwright/.cache/performance" },
	projects: [{ name: "edge", use: { browserName: "chromium", channel: "msedge" } }],
}
