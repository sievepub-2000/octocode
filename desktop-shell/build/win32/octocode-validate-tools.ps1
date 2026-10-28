param([Parameter(Mandatory = $true)][string]$AppRoot)
$ErrorActionPreference = 'Stop'
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
if ($AppRoot -eq [IO.Path]::GetPathRoot($AppRoot).TrimEnd('\')) { throw 'A drive root is not an application directory' }
$environments = Join-Path $AppRoot 'environments'
$applicationParents = @()
$current = $AppRoot
while ($current) {
	$applicationParents += $current
	$parent = [IO.Directory]::GetParent($current)
	$current = if ($null -eq $parent) { $null } else { $parent.FullName }
}
foreach ($path in @($applicationParents) + @($environments)) {
	try { $attributes = [IO.File]::GetAttributes($path) }
	catch [IO.FileNotFoundException] { continue }
	catch [IO.DirectoryNotFoundException] { continue }
	$item = Get-Item -LiteralPath $path -Force
	if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
		$expected = 'D:\gpt-workspace\octocode\runtime\environments'
		$actual = ([string]@($item.Target)[0]).Replace('\\?\', '').TrimEnd('\')
		if ($path -ine 'D:\Program Files\OctoCode\environments' -or $actual -ine $expected) {
			throw "Unapproved application storage link: $path"
		}
	}
}
# These paths receive the updater and its payload before Python can run. Inspect
# physical children ourselves; never recurse through a junction or symbolic link.
foreach ($relative in @('tools', 'installer', 'scripts')) {
	$pending = [Collections.Generic.Stack[string]]::new()
	$pending.Push((Join-Path $environments $relative))
	while ($pending.Count) {
		$path = $pending.Pop()
		try { $attributes = [IO.File]::GetAttributes($path) }
		catch [IO.FileNotFoundException] { continue }
		catch [IO.DirectoryNotFoundException] { continue }
		if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked tool installation content: $path" }
		$item = Get-Item -LiteralPath $path -Force
		if ($item.PSIsContainer) {
			foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $pending.Push($child.FullName) }
		}
	}
}
