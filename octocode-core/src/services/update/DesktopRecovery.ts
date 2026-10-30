import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Socket } from "node:net"

/** Independent of the shell's native updater. No credentials enter this plan. */
export interface RecoveryPlan {
	mainPid: number
	executable: string
	installer: string
	sha256: string
	version: string
	journal: string
}

// A Process handle is captured before acknowledging readiness, so PID reuse or
// a vetoed quit cannot cause installation over the running application.
export const recoveryPowerShell = String.raw`
param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
$dir = Split-Path -LiteralPath $Plan
function Save-State([string]$state, [string]$reason = '') {
  $record = @{state=$state;version=$p.version;time=[DateTime]::UtcNow.ToString('o')}
  if ($reason) { $record.reason = $reason }
  $text = $record | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($p.journal, $text, [Text.UTF8Encoding]::new($false))
}
$locked = $false
$mutex = [Threading.Mutex]::new($false, ('Local\OctoCodeRecovery-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw 'Another recovery is already active' }
  $main = [Diagnostics.Process]::GetProcessById([int]$p.mainPid)
  $null = $main.Handle
  if (![String]::Equals($main.MainModule.FileName, $p.executable, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Application identity changed'
  }
  Save-State 'waiting_for_exit'
  [IO.File]::WriteAllText((Join-Path $dir 'ready'), 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (!$main.WaitForExit(200)) {
    if (Test-Path -LiteralPath (Join-Path $dir 'cancel')) { Save-State 'cancelled'; return }
    if ([DateTime]::UtcNow -ge $deadline) { Save-State 'quit_vetoed_or_timed_out'; return }
  }
  if (Test-Path -LiteralPath (Join-Path $dir 'cancel')) { Save-State 'cancelled'; return }
  # Deny writes/replacement while hashing and starting the same installer path.
  $file = [IO.File]::Open($p.installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($hash.ComputeHash($file))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
    if ($actual -cne $p.sha256) { Save-State 'checksum_failed'; return }
    $target = [IO.Path]::GetDirectoryName($p.executable)
    if ($target.Contains('"') -or $p.installer.Contains('"')) { throw 'Invalid installation path' }
    $installerArgs = @('/VERYSILENT', '/log', '/NORESTART', '/NOCLOSEAPPLICATIONS', '/mergetasks=runcode,!desktopicon,!quicklaunchicon', ('/DIR="' + $target + '"'))
    Save-State 'installing'
    $setup = Start-Process -FilePath $p.installer -ArgumentList $installerArgs -PassThru
  } finally { $file.Dispose() }
  $setup.WaitForExit()
  if ($setup.ExitCode -eq 0) { Save-State 'completed' }
  else { Save-State ('installer_exit_' + $setup.ExitCode) }
} catch {
  if (!$locked) { [IO.File]::WriteAllText((Join-Path $dir 'failed'), 'Another recovery is already active') }
  elseif ($_.Exception.NativeErrorCode -eq 1223) { Save-State 'elevation_cancelled' }
  else { Save-State 'failed' $_.Exception.GetType().Name }
} finally {
  if ($main) { $main.Dispose() }
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  # Only names created in this unique recovery directory are removed.
  foreach ($name in @('OctoCodeSetup.exe','plan.json','ready','cancel','helper.ps1')) {
    Remove-Item -LiteralPath (Join-Path $dir $name) -Force -ErrorAction SilentlyContinue
  }
  if ((Get-ChildItem -LiteralPath $dir -Force | Measure-Object).Count -eq 0) {
    Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
  }
}
`

/** Prepare the waiting helper before asking the workbench to quit. */
export async function startRecoveryHelper(directory: string, plan: RecoveryPlan): Promise<() => Promise<void>> {
	if (!Number.isSafeInteger(plan.mainPid) || plan.mainPid <= 0 || !/^[a-f0-9]{64}$/.test(plan.sha256))
		throw new Error("Invalid recovery process or digest")
	if (path.resolve(plan.installer) !== path.join(path.resolve(directory), "OctoCodeSetup.exe"))
		throw new Error("Recovery installer is outside its download directory")
	const planFile = path.join(directory, "plan.json")
	const script = path.join(directory, "helper.ps1")
	await fs.writeFile(planFile, JSON.stringify(plan), { flag: "wx" })
	await fs.writeFile(script, recoveryPowerShell, { flag: "wx" })
	const powershell = path.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	)
	// Windows PowerShell can silently exit when Node uses DETACHED_PROCESS.
	// Start-Process provides an independent hidden process without that flag.
	if (script.includes('"') || planFile.includes('"')) throw new Error("Invalid recovery helper path")
	const paths = Buffer.from(JSON.stringify({ script, planFile }), "utf8").toString("base64")
	const launcher = `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${paths}')) | ConvertFrom-Json; Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $p.script + '"'),'-Plan',('"' + $p.planFile + '"'))`
	const child = spawn(
		powershell,
		["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")],
		{
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		},
	)
	let failure: Error | undefined
	let diagnostics = ""
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics = (diagnostics + chunk.toString()).slice(-4096)
	})
	if (child.stderr instanceof Socket) child.stderr.unref()
	child.once("error", (error) => {
		failure = error
	})
	child.unref()
	const cancel = async () => {
		await fs.writeFile(path.join(directory, "cancel"), "cancel")
	}
	for (let attempt = 0; attempt < 100; attempt++) {
		if (failure) throw failure
		const refused = await fs.readFile(path.join(directory, "failed"), "utf8").catch(() => undefined)
		if (refused) throw new Error(refused)
		if (child.exitCode !== null && child.exitCode !== 0) {
			const state = await fs.readFile(plan.journal, "utf8").catch(() => "no journal")
			throw new Error(`Recovery helper stopped before it was ready (${child.exitCode}): ${state}; ${diagnostics}`)
		}
		try {
			await fs.access(path.join(directory, "ready"))
			return cancel
		} catch {
			/* wait for the captured process handle */
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	await cancel()
	throw new Error("Recovery helper did not become ready")
}
