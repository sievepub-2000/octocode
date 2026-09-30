import React, { useRef, useLayoutEffect, memo } from "react"
import { useWindowSize } from "react-use"
import { vscode } from "@src/utils/vscode"

interface ThumbnailsProps {
	images: string[]
	style?: React.CSSProperties
	setImages?: React.Dispatch<React.SetStateAction<string[]>>
	onHeightChange?: (height: number) => void
}

const Thumbnails = ({ images, style, setImages, onHeightChange }: ThumbnailsProps) => {
	const containerRef = useRef<HTMLDivElement>(null)
	const { width } = useWindowSize()

	useLayoutEffect(() => {
		if (containerRef.current) {
			let height = containerRef.current.clientHeight
			// some browsers return 0 for clientHeight
			if (!height) {
				height = containerRef.current.getBoundingClientRect().height
			}
			onHeightChange?.(height)
		}
	}, [images, width, onHeightChange])

	const handleDelete = (index: number) => {
		setImages?.((prevImages) => prevImages.filter((_, i) => i !== index))
	}

	const isDeletable = setImages !== undefined

	const handleImageClick = (image: string) => {
		vscode.postMessage({ type: "openImage", text: image })
	}

	return (
		<div
			ref={containerRef}
			className="py-1"
			style={{
				display: "flex",
				flexWrap: "wrap",
				gap: 5,
				rowGap: 3,
				...style,
			}}>
			{images.map((image, index) => (
				<div key={index} style={{ position: "relative" }}>
					<button
						type="button"
						className="focus-visible:outline-2 focus-visible:outline-[var(--vscode-focusBorder)]"
						aria-label={`Open image ${index + 1}`}
						onClick={() => handleImageClick(image)}
						style={{ padding: 0, border: 0, background: "none", cursor: "pointer" }}>
						<img
							src={image}
							alt={`Thumbnail ${index + 1}`}
							style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 4, display: "block" }}
						/>
					</button>
					{isDeletable && (
						<button
							type="button"
							className="focus-visible:outline-2 focus-visible:outline-[var(--vscode-focusBorder)]"
							aria-label={`Remove image ${index + 1}`}
							onClick={() => handleDelete(index)}
							style={{
								position: "absolute",
								top: -4,
								right: -4,
								width: 18,
								height: 18,
								borderRadius: "50%",
								backgroundColor: "var(--vscode-badge-background)",
								display: "flex",
								justifyContent: "center",
								alignItems: "center",
								cursor: "pointer",
								border: 0,
								padding: 0,
							}}>
							<span
								className="codicon codicon-close"
								aria-hidden="true"
								style={{
									color: "var(--vscode-foreground)",
									fontSize: 10,
									fontWeight: "bold",
								}}></span>
						</button>
					)}
				</div>
			))}
		</div>
	)
}

export default memo(Thumbnails)
