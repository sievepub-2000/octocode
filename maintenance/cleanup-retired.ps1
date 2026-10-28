param([switch]$Apply)
$ErrorActionPreference='Stop'
$project='D:\gpt-workspace\octocode'
$source=Join-Path $project 'source'
. (Join-Path $source 'build-product-safety.ps1')
$retired=Join-Path $source 'optimization-20260911'
$current=Get-Content -LiteralPath (Join-Path $project 'releases\release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-CurrentInstallerFile($Manifest){
    if($Manifest.shellVersion -isnot [string] -or $Manifest.shellVersion -notmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z'){throw 'Invalid current shellVersion'}
    if($Manifest.installer.sha256 -isnot [string] -or $Manifest.installer.sha256 -notmatch '\A[a-fA-F0-9]{64}\z'){throw 'Invalid current installer hash'}
    $file=$Manifest.installer.file
    if($file -isnot [string] -or $file -notmatch '\AOctoCodeSetup-(latest|[0-9]+\.[0-9]+\.[0-9]+)\.exe\z'){throw 'Invalid current installer filename'}
    return $file
}
$installerFile=Get-CurrentInstallerFile $current
$evidence=Join-Path $project ('verification\release-'+$current.shellVersion)
function Test-CurrentUpgradeProof($Proof,$Manifest,[string]$InstalledFileVersion){
    return ($null -ne $Proof -and
        $Proof.step -is [string] -and $Proof.step -ceq 'Upgrade' -and
        ($Proof.exitCode -is [int] -or $Proof.exitCode -is [long]) -and $Proof.exitCode -eq 0 -and
        $Proof.preservation -is [string] -and $Proof.preservation -ceq 'PASS' -and
        $Proof.shellVersion -is [string] -and $Proof.shellVersion -ceq $Manifest.shellVersion -and
        $Proof.installerSha256 -is [string] -and $Proof.installerSha256 -ieq $Manifest.installer.sha256 -and
        ![string]::IsNullOrWhiteSpace($InstalledFileVersion) -and $InstalledFileVersion -ceq $Manifest.shellVersion)
}
function Assert-CleanupTarget([string]$Target){
    $resolved=[IO.Path]::GetFullPath($Target)
    if(!$resolved.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Cleanup outside project: $resolved"}
    if((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Unexpected top-level link: $resolved"}
    Assert-PhysicalBuildPath -Path $resolved -ScopeDirectory $project -InspectChildren
}
$targets=@()
$targets+=Get-ChildItem (Join-Path $project 'backups') -Force | Where-Object { $_.Name -ne 'current-config' -and $_.Name -notlike 'current-config-previous-*' } | ForEach-Object FullName
$targets+=Get-ChildItem (Join-Path $project 'releases') -Force | Where-Object {$_.Name -notin @('OctoCodeSetup-latest.exe','release-manifest.json',$installerFile) -and $_.Extension -ne '.md'} | ForEach-Object FullName
$targets+=@($retired,(Join-Path $source 'desktop-shell\work\audit-bundle'),(Join-Path $source 'desktop-shell\work\build-portable.mjs')) | Where-Object {Test-Path -LiteralPath $_}
$targets+=Get-ChildItem (Join-Path $project 'backups\current-config') -Directory -Filter 'restore-check-*' | ForEach-Object FullName
foreach($target in $targets){
    Assert-CleanupTarget $target
}
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$targets | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $evidence 'retired-cleanup-plan.json')
if(!$Apply){$targets;exit}
$installedExe=Get-Item -LiteralPath 'E:\Program Files\octocode\OctoCode.exe' -ErrorAction Stop
$upgradePassed=$false
foreach($proofFile in @(Get-ChildItem -LiteralPath $evidence -File -Filter 'native-Upgrade-*.log.json')){
    try {$proof=Get-Content -LiteralPath $proofFile.FullName -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop}
    catch {continue}
    if(Test-CurrentUpgradeProof $proof $current $installedExe.VersionInfo.FileVersion){$upgradePassed=$true;break}
}
if(!$upgradePassed){throw 'No successful Upgrade proof bound to current shell version, installer hash and installed executable'}
if((Get-FileHash -LiteralPath (Join-Path $project ('releases\'+$installerFile)) -Algorithm SHA256).Hash -ne $current.installer.sha256){throw 'Current installer hash mismatch'}
$reports=Join-Path $project 'reports'
New-Item -ItemType Directory -Path $reports -Force | Out-Null
foreach($report in (Get-ChildItem (Join-Path $project 'releases') -File -Filter '*.md')){
    $destination=[IO.Path]::GetFullPath((Join-Path $reports $report.Name))
    if(!$destination.StartsWith($reports+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Report path escaped project reports'}
    if(Test-Path -LiteralPath $destination){
        if((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $report.FullName).Hash){throw 'Conflicting historical report'}
        Remove-Item -LiteralPath $report.FullName
    }else{Move-Item -LiteralPath $report.FullName -Destination $destination}
}
foreach($process in (Get-CimInstance Win32_Process)){
    if($process.CommandLine -and $process.CommandLine.IndexOf($retired,[StringComparison]::OrdinalIgnoreCase) -ge 0){throw "Retired worktree still in use by PID $($process.ProcessId)"}
}
foreach($name in @('desktop-shell','octo-harness')){
    $tree=[IO.Path]::GetFullPath((Join-Path $retired $name))
    if(!$tree.StartsWith($retired+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Worktree escaped retired scope'}
    if(Test-Path -LiteralPath $tree){
        & git -C (Join-Path $source $name) worktree remove --force $tree
        if($LASTEXITCODE){throw "Could not remove retired $name worktree"}
    }
}
foreach($target in $targets){
    if(!(Test-Path -LiteralPath $target)){continue}
    Assert-CleanupTarget $target
    $entry=Get-Item -LiteralPath $target -Force
    if($entry.PSIsContainer){
        # Detach directory links without visiting or removing their destinations.
        $stack=New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
        $stack.Push([IO.DirectoryInfo]$entry)
        while($stack.Count){
            foreach($child in $stack.Pop().GetFileSystemInfos()){
                if($child.Attributes -band [IO.FileAttributes]::ReparsePoint){
                    if($child.Attributes -band [IO.FileAttributes]::Directory){[IO.Directory]::Delete($child.FullName)}else{[IO.File]::Delete($child.FullName)}
                }elseif($child.Attributes -band [IO.FileAttributes]::Directory){$stack.Push([IO.DirectoryInfo]$child)}
            }
        }
        Remove-Item -LiteralPath $target -Recurse -Force
    }else{Remove-Item -LiteralPath $target -Force}
}
foreach($target in $targets){if(Test-Path -LiteralPath $target){throw "Retired content remains: $target"}}
@{checkedAt=(Get-Date).ToString('o');removed=$targets;currentInstaller=$current.installer.sha256} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $evidence 'retired-cleanup-result.json')
'Retired versions removed; current installer, configuration, user files and Git history retained'
