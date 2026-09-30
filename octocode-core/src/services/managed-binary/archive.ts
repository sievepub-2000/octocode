import { spawn } from "child_process"
import * as path from "path"

export interface ProcessResult {
	stdout: string
	stderr: string
}

function quotePowerShellString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64")
}

async function runPowerShell(script: string, timeoutMs?: number): Promise<ProcessResult> {
	return runProcess(
		"powershell",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(script)],
		timeoutMs,
	)
}

/** Toolchains such as Go unpack ~13k files; the 30 s process default cut them off mid-extraction. */
const ZIP_EXTRACT_TIMEOUT_MS = 20 * 60_000

export function runProcess(
	executable: string,
	args: string[],
	timeoutMs = 30_000,
	env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			...(env ? { env: { ...process.env, ...env } } : {}),
		})
		let stdout = ""
		let stderr = ""
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`${path.basename(executable)} timed out`))
		}, timeoutMs)
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.on("error", (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			if (code === 0) {
				resolve({ stdout, stderr })
			} else {
				reject(new Error(stderr.trim() || `Process exited with code ${code}`))
			}
		})
	})
}

/**
 * Which `tar` to run, and which flags it understands.
 *
 * On Windows, PATH usually resolves `tar` to Git's GNU tar, which reads a
 * leading `C:` as the host part of rmt's `host:path` syntax and fails with
 * "Cannot connect to C: resolve failed". `--force-local` does NOT rescue it
 * (verified: still exits 2). Windows 10 1803+ ships bsdtar at System32\tar.exe,
 * which handles drive-letter paths natively, so address it by absolute path
 * rather than trusting PATH.
 *
 * bsdtar also rejects the GNU-only ownership flags, so they are gated too.
 */
function tarCommand(): { exe: string; gnuFlags: string[] } {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows"
		return { exe: path.join(systemRoot, "System32", "tar.exe"), gnuFlags: [] }
	}
	const gnuFlags = ["--no-same-owner"]
	if (process.platform === "linux") {
		gnuFlags.push("--no-overwrite-dir")
	}
	return { exe: "tar", gnuFlags }
}

export async function extractTarGzArchive(archivePath: string, destination: string): Promise<void> {
	const { exe, gnuFlags } = tarCommand()
	await runProcess(exe, ["-xzf", archivePath, "-C", destination, ...gnuFlags])
}

export async function extractTarXzArchive(archivePath: string, destination: string): Promise<void> {
	const { exe, gnuFlags } = tarCommand()
	await runProcess(exe, ["-xJf", archivePath, "-C", destination, ...gnuFlags])
}

export async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
	if (process.platform === "win32") {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			`$archivePath = ${quotePowerShellString(archivePath)}`,
			`$destination = ${quotePowerShellString(destination)}`,
			// Expand-Archive on Windows PowerShell 5.1 takes minutes for large archives;
			// ZipFile entry extraction is an order of magnitude faster. Entries that
			// would land outside the destination are refused.
			"Add-Type -AssemblyName System.IO.Compression.FileSystem",
			"$root = [System.IO.Path]::GetFullPath($destination).TrimEnd('\\') + '\\'",
			"$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)",
			"try {",
			"  foreach ($entry in $archive.Entries) {",
			"    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $entry.FullName))",
			'    if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Archive entry escapes the destination: $($entry.FullName)" }',
			"    if ([string]::IsNullOrEmpty($entry.Name)) { [void][System.IO.Directory]::CreateDirectory($target); continue }",
			"    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target))",
			"    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)",
			"  }",
			"} finally { $archive.Dispose() }",
		].join("; ")
		await runPowerShell(script, ZIP_EXTRACT_TIMEOUT_MS)
		return
	}

	await runProcess("unzip", ["-o", archivePath, "-d", destination], ZIP_EXTRACT_TIMEOUT_MS)
}

export async function extractSingleFileZipArchive(
	archivePath: string,
	destination: string,
	expectedFile: string,
	archiveName: string,
): Promise<void> {
	if (process.platform !== "win32") {
		throw new Error("Single-file ZIP extraction is only supported on Windows")
	}

	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$archivePath = ${quotePowerShellString(archivePath)}`,
		`$outputPath = ${quotePowerShellString(path.join(destination, expectedFile))}`,
		`$expectedFile = ${quotePowerShellString(expectedFile)}`,
		`$archiveName = ${quotePowerShellString(archiveName)}`,
		"Add-Type -AssemblyName System.IO.Compression.FileSystem",
		"$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)",
		"try {",
		"  $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })",
		'  if ($entries.Count -ne 1 -or $entries[0].FullName -ne $expectedFile) { throw "$archiveName archive has an unexpected layout" }',
		"  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $outputPath, $false)",
		"} finally { $archive.Dispose() }",
	].join("; ")

	await runPowerShell(script)
}

export async function extractSingleFileTarXzArchive(
	archivePath: string,
	destination: string,
	expectedFile: string,
	archiveName: string,
): Promise<void> {
	const listing = await runProcess("tar", ["-tvJf", archivePath])
	const entries = listing.stdout
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean)
	if (entries.length !== 1) {
		throw new Error(`${archiveName} archive has an unexpected layout`)
	}
	const archiveEntry = entries[0]
	const entryName = archiveEntry?.split(/\s+/).at(-1)
	if (
		!archiveEntry ||
		!entryName ||
		!archiveEntry.startsWith("-") ||
		entryName.replace(/^\.\//, "") !== expectedFile
	) {
		throw new Error(`${archiveName} archive has an unexpected layout`)
	}

	const args = ["-xJf", archivePath, "-C", destination, "--no-same-owner"]
	if (process.platform === "linux") {
		args.push("--no-overwrite-dir")
	}
	args.push(entryName)
	await runProcess("tar", args)
}
