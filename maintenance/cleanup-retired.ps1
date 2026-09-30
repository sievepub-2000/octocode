param([switch]$Apply)
$ErrorActionPreference='Stop'
$project='D:\gpt-workspace\octocode'
$source=Join-Path $project 'source'
$retired=Join-Path $source 'optimization-20260911'
$evidence=Join-Path $project 'verification\release-20260921'
$targets=@()
$targets+=Get-ChildItem (Join-Path $project 'backups') -Force | Where-Object Name -ne 'current-config' | ForEach-Object FullName
$targets+=Get-ChildItem (Join-Path $project 'releases') -Force | Where-Object {$_.Name -notin @('OctoCodeSetup-latest.exe','release-manifest.json') -and $_.Extension -ne '.md'} | ForEach-Object FullName
$targets+=@($retired,(Join-Path $source 'desktop-shell\work\audit-bundle'),(Join-Path $source 'desktop-shell\work\build-portable.mjs')) | Where-Object {Test-Path -LiteralPath $_}
$targets+=Get-ChildItem (Join-Path $project 'backups\current-config') -Directory -Filter 'restore-check-*' | ForEach-Object FullName
foreach($target in $targets){
    $resolved=[IO.Path]::GetFullPath($target)
    if(!$resolved.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Cleanup outside project: $resolved"}
    if((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Unexpected top-level link: $resolved"}
}
$targets | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $evidence 'retired-cleanup-plan.json')
if(!$Apply){$targets;exit}
if(!(Test-Path (Join-Path $evidence 'installed-acceptance-pass.json'))){throw 'Final installation acceptance has not passed'}
$current=Get-Content (Join-Path $project 'releases\release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if((Get-FileHash (Join-Path $project 'releases\OctoCodeSetup-latest.exe')).Hash -ne $current.installer.sha256){throw 'Current installer hash mismatch'}
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
