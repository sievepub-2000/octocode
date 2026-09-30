import { useEffect, useRef } from "react"

const ThreeScene = ({ src }: { src: string }) => {
	const hostRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let dispose = () => undefined
		void (async () => {
			const THREE = await import("three")
			const [{ GLTFLoader }, { OrbitControls }] = await Promise.all([
				import("three/addons/loaders/GLTFLoader.js"),
				import("three/addons/controls/OrbitControls.js"),
			])
			const host = hostRef.current
			if (!host) return
			const scene = new THREE.Scene()
			scene.background = new THREE.Color(0x181818)
			const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.01, 1000)
			camera.position.set(2, 2, 3)
			let renderer: import("three").WebGLRenderer | import("three/webgpu").WebGPURenderer
			try {
				const { WebGPURenderer } = await import("three/webgpu")
				const webgpu = new WebGPURenderer({ antialias: true })
				await webgpu.init()
				renderer = webgpu
			} catch {
				renderer = new THREE.WebGLRenderer({ antialias: true })
			}
			renderer.setSize(host.clientWidth, host.clientHeight)
			host.appendChild(renderer.domElement)
			const controls = new OrbitControls(camera, renderer.domElement)
			scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 3))
			const model = await new GLTFLoader().loadAsync(src)
			scene.add(model.scene)
			const bounds = new THREE.Box3().setFromObject(model.scene)
			controls.target.copy(bounds.getCenter(new THREE.Vector3()))
			const radius = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.1)
			camera.position.set(radius, radius * 0.7, radius)
			controls.update()
			let frame = 0
			const draw = () => { frame = requestAnimationFrame(draw); controls.update(); renderer.render(scene, camera) }
			draw()
			const resize = new ResizeObserver(() => {
				camera.aspect = host.clientWidth / host.clientHeight
				camera.updateProjectionMatrix()
				renderer.setSize(host.clientWidth, host.clientHeight)
			})
			resize.observe(host)
			dispose = () => { cancelAnimationFrame(frame); resize.disconnect(); controls.dispose(); renderer.dispose(); renderer.domElement.remove() }
		})().catch(() => undefined)
		return () => dispose()
	}, [src])

	return <div className="h-full min-h-80 w-full" ref={hostRef} />
}

export default ThreeScene
