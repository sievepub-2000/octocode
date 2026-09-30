import { describe, expect, it } from "vitest"

import { getArtifactKind } from "../artifactKind"

describe("getArtifactKind", () => {
	it.each([
		["demo.ts", "code"],
		["photo.webp", "image"],
		["paper.pdf", "pdf"],
		["clip.mp4", "video"],
		["voice.flac", "audio"],
		["scene.glb", "model"],
	])("classifies %s as %s", (path, kind) => expect(getArtifactKind(path)).toBe(kind))
})
