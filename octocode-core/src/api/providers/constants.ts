import { Package } from "../../shared/package"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://github.com/OctoCode-Org/OctoCode",
	"X-Title": "OctoCode",
	"User-Agent": `OctoCode/${Package.version}`,
}
