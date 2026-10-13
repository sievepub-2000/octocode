function Invoke-BuildVersionProbe {
	param(
		[Parameter(Mandatory)][string]$FilePath,
		[Parameter(Mandatory)][string[]]$Arguments,
		[Parameter(Mandatory)][string]$Pattern,
		[Parameter(Mandatory)][string]$Label
	)
	$output = & $FilePath @Arguments
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) { throw "$Label version probe failed (exit $exitCode)" }
	$value = (@($output) -join "`n").Trim()
	if ($value -notmatch $Pattern) { throw "Unexpected $Label version output" }
	$value
}

function Assert-PhysicalBuildPath {
	param(
		[Parameter(Mandatory)][string]$Path,
		[Parameter(Mandatory)][string]$ScopeDirectory,
		[switch]$InspectChildren
	)
	$resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
	$scope = [IO.Path]::GetFullPath($ScopeDirectory).TrimEnd('\')
	if (-not $resolved.StartsWith($scope + '\', [StringComparison]::OrdinalIgnoreCase)) {
		throw "Build path escaped source directory: $resolved"
	}
	$cursor = $resolved
	while ($cursor.Equals($scope, [StringComparison]::OrdinalIgnoreCase) -or
		$cursor.StartsWith($scope + '\', [StringComparison]::OrdinalIgnoreCase)) {
		if ((Get-Item -LiteralPath $cursor -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) {
			throw "Build path contains a reparse point: $cursor"
		}
		$cursor = [IO.Path]::GetDirectoryName($cursor)
	}
	if ($InspectChildren) {
		$pending = [Collections.Generic.Stack[string]]::new()
		$pending.Push($resolved)
		while ($pending.Count) {
			foreach ($entry in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
				if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
					throw "Build tree contains a reparse point: $($entry.FullName)"
				}
				if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
			}
		}
	}
}

function Assert-StoppedBuildProduct {
	param([Parameter(Mandatory)][string]$ProductRoot)
	$resolved = [IO.Path]::GetFullPath($ProductRoot).TrimEnd('\')
	$running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
		$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)
	})
	if ($running) { throw "Product tree is running; stop it before changing the build: $($running.ProcessId -join ', ')" }
}
