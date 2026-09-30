import "./vscode-theme-dark.css"
// Match the exact CSS/font pair packaged by ClineProvider in production.
import "../../src/assets/codicons/codicon.css"
import "../src/index.css"
import "./vscode-theme-light.css"

// Components read `window.IMAGES_BASE_URI` at mount time to resolve extension
// image assets. Under Playwright CT the extension host isn't present, so seed
// it to serve from the CT bundle root (mapped to src/assets/images via
// `publicDir` in playwright-ct.config.ts).
;(window as unknown as { IMAGES_BASE_URI: string }).IMAGES_BASE_URI = ""
