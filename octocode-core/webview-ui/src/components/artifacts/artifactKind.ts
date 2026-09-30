export type ArtifactKind = "audio" | "code" | "image" | "logs" | "model" | "pdf" | "video"

const extensionKinds: Record<string, ArtifactKind> = {
	flac: "audio",
	glb: "model",
	gltf: "model",
	jpeg: "image",
	jpg: "image",
	m4a: "audio",
	mov: "video",
	mp3: "audio",
	mp4: "video",
	ogg: "audio",
	pdf: "pdf",
	png: "image",
	svg: "image",
	wav: "audio",
	webm: "video",
	webp: "image",
}

export const getArtifactKind = (path: string): ArtifactKind =>
	extensionKinds[path.split(".").pop()?.toLowerCase() ?? ""] ?? "code"
