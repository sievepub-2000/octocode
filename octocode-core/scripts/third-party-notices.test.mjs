import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { writeThirdPartyNotices } from "./third-party-notices.mjs"

test("required external components cannot disappear from license evidence", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-notices-"))
	try {
		assert.throws(
			() =>
				writeThirdPartyNotices([], path.join(directory, "NOTICE"), [
					path.join(directory, "missing", "package.json"),
				]),
			/Required third-party component/,
		)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("ships complete supplied license text and fails when a bundled license is absent", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-notices-"))
	try {
		const component = path.join(directory, "node_modules", "license-fixture")
		fs.mkdirSync(component, { recursive: true })
		const manifest = path.join(component, "package.json")
		fs.writeFileSync(
			manifest,
			JSON.stringify({ name: "octocode-license-fixture", version: "1.0.0", license: "MIT" }),
		)
		const license = "Copyright fixture author. Permission to test complete license copying. ".repeat(10)
		fs.writeFileSync(path.join(component, "LICENSE"), license)
		const destination = path.join(directory, "NOTICE")
		writeThirdPartyNotices([manifest], destination)
		assert(fs.readFileSync(destination, "utf8").includes(license.trim()))
		assert.equal(JSON.parse(fs.readFileSync(`${destination}.json`, "utf8"))[0].name, "octocode-license-fixture")
		fs.unlinkSync(path.join(component, "LICENSE"))
		assert.throws(() => writeThirdPartyNotices([manifest], destination), /Missing complete license evidence/)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
