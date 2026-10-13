$ErrorActionPreference='Stop'
$sourceRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $sourceRoot 'build-product-safety.ps1')
$releaseFixture=Join-Path ([IO.Path]::GetTempPath()) ('release-proof-check-'+[guid]::NewGuid().ToString('N'))
try {
    $project=$releaseFixture
    $releases=Join-Path $project 'releases'
    New-Item -ItemType Directory -Path $releases | Out-Null
    $manifest=[pscustomobject]@{shellVersion='1.132.2';installer=[pscustomobject]@{file='OctoCodeSetup-1.132.2.exe';sha256=('A'*64)}}
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releases 'release-manifest.json') -Encoding UTF8
    foreach($name in @('OctoCodeSetup-latest.exe','OctoCodeSetup-1.132.2.exe','OctoCodeSetup-1.132.1.exe','release-notes.md')){
        [IO.File]::WriteAllText((Join-Path $releases $name),'owned fixture')
    }
    $oldTargets=@(Get-ChildItem -LiteralPath $releases | Where-Object {$_.Name -notin @('OctoCodeSetup-latest.exe','release-manifest.json') -and $_.Extension -ne '.md'})
    if('OctoCodeSetup-1.132.2.exe' -notin $oldTargets.Name){throw 'Original current-artifact deletion was not reproduced'}
    $tokens=$null; $parseErrors=$null
    $cleanupAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRoot 'maintenance\cleanup-retired.ps1'),[ref]$tokens,[ref]$parseErrors)
    if($parseErrors.Count){throw $parseErrors[0]}
    foreach($name in @('Get-CurrentInstallerFile','Test-CurrentUpgradeProof')){
        $helper=$cleanupAst.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
        if(!$helper){throw "Missing cleanup helper: $name"}
        . ([scriptblock]::Create($helper.Extent.Text))
    }
    $read=$cleanupAst.EndBlock.Statements | Where-Object {$_.Extent.Text -like '$current=Get-Content*'}
    . ([scriptblock]::Create($read.Extent.Text))
    $installerFile=Get-CurrentInstallerFile $current
    $targets=@()
    $selection=$cleanupAst.EndBlock.Statements | Where-Object {$_.Extent.Text -like '$targets+=Get-ChildItem*' -and $_.Extent.Text -like '*releases*'}
    . ([scriptblock]::Create($selection.Extent.Text))
    if($targets.Count -ne 1 -or [IO.Path]::GetFileName($targets[0]) -ne 'OctoCodeSetup-1.132.1.exe'){throw 'Current manifest artifact entered cleanup targets'}
    $backups=Join-Path $project 'backups'
    foreach($name in @('current-config','current-config-previous-owned','retired-owned')){New-Item -ItemType Directory -Path (Join-Path $backups $name) -Force | Out-Null}
    $targets=@()
    $selection=$cleanupAst.EndBlock.Statements | Where-Object {$_.Extent.Text -like '$targets+=Get-ChildItem*' -and $_.Extent.Text -like '*current-config-previous-*'}
    . ([scriptblock]::Create($selection.Extent.Text))
    if($targets.Count -ne 1 -or [IO.Path]::GetFileName($targets[0]) -ne 'retired-owned'){throw 'Verified backup generation entered cleanup targets'}
    foreach($badName in @('../OctoCodeSetup-1.132.2.exe','sub\OctoCodeSetup-1.132.2.exe','D:\OctoCodeSetup-1.132.2.exe','OctoCodeSetup-1.132.2.exe:stream','OctoCodeSetup-*.exe','',"OctoCodeSetup-1.132.2.exe`n")){
        $candidate=Get-Content -LiteralPath (Join-Path $releases 'release-manifest.json') -Raw | ConvertFrom-Json
        $candidate.installer.file=$badName
        $rejected=$false
        try {Get-CurrentInstallerFile $candidate | Out-Null} catch {$rejected=$true}
        if(!$rejected){throw "Unsafe manifest filename accepted: $badName"}
    }
    $proofPath=Join-Path $releaseFixture 'native-Upgrade-owned.log.json'
    $valid=@{step='Upgrade';exitCode=0;preservation='PASS';shellVersion='1.132.2';installerSha256=('a'*64)}
    $valid | ConvertTo-Json | Set-Content -LiteralPath $proofPath -Encoding UTF8
    $proof=Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
    if(!(Test-CurrentUpgradeProof $proof $current '1.132.2')){throw 'Current successful upgrade JSON rejected'}
    foreach($field in @('step','exitCode','preservation','shellVersion','installerSha256')){
        foreach($value in @($null,'wrong')){
            $candidate=Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
            $candidate.$field=$value
            $candidate | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseFixture 'invalid.json') -Encoding UTF8
            $candidate=Get-Content -LiteralPath (Join-Path $releaseFixture 'invalid.json') -Raw | ConvertFrom-Json
            if(Test-CurrentUpgradeProof $candidate $current '1.132.2'){throw "Unbound proof accepted: $field"}
        }
    }
    foreach($version in @('','1.132.1','1.132.2.0')){
        if(Test-CurrentUpgradeProof $proof $current $version){throw 'Incorrect installed FileVersion accepted'}
    }
    foreach($exitCode in @(1,'0',$false)){
        $candidate=Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
        $candidate.exitCode=$exitCode
        if(Test-CurrentUpgradeProof $candidate $current '1.132.2'){throw 'Invalid exit code accepted'}
    }
    if(Test-CurrentUpgradeProof $null $current '1.132.2'){throw 'Absent proof accepted'}
    foreach($field in @('step','preservation')){
        $candidate=Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
        $candidate.$field=@($candidate.$field,'wrong')
        if(Test-CurrentUpgradeProof $candidate $current '1.132.2'){throw 'Array-valued proof field accepted'}
    }
    # Execute only the evidence-selection loop and its fail-closed assertion.
    $proofLoop=$cleanupAst.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Extent.Text -like '*native-Upgrade-*.log.json*'},$true)
    $gate=$cleanupAst.EndBlock.Statements | Where-Object {$_.Extent.Text -like 'if(!$upgradePassed)*'}
    if(!$proofLoop -or !$gate){throw 'Current Upgrade evidence gate not found'}
    $evidence=Join-Path $releaseFixture 'proofs'
    New-Item -ItemType Directory -Path $evidence | Out-Null
    $installedExe=[pscustomobject]@{VersionInfo=[pscustomobject]@{FileVersion='1.132.2'}}
    foreach($scenario in @('none','malformed','valid')){
        if($scenario -eq 'malformed'){'not JSON' | Set-Content -LiteralPath (Join-Path $evidence 'native-Upgrade-malformed.log.json')}
        if($scenario -eq 'valid'){Copy-Item -LiteralPath $proofPath -Destination (Join-Path $evidence 'native-Upgrade-valid.log.json')}
        $upgradePassed=$false
        . ([scriptblock]::Create($proofLoop.Extent.Text))
        $rejected=$false
        try {. ([scriptblock]::Create($gate.Extent.Text))} catch {$rejected=$true}
        if(($scenario -eq 'valid' -and $rejected) -or ($scenario -ne 'valid' -and !$rejected)){throw "Upgrade gate failed scenario: $scenario"}
    }
    'Manifest artifact retention, filename validation and bound Upgrade proof predicate PASS'
} finally {
    if([IO.Path]::GetFullPath($releaseFixture) -ne $releaseFixture){throw 'Release fixture cleanup escaped owned path'}
    if(Test-Path -LiteralPath $releaseFixture){Remove-Item -LiteralPath $releaseFixture -Recurse -Force}
}
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRoot 'build-desktop-product.remote.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw $parseErrors[0]}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-BuildDirectory'},$true)
if(!$function){throw 'Remove-BuildDirectory function not found'}
# Replace only variable AST nodes, including case variants, without touching literals.
$definition=$function.Extent.Text
$rootLiteral="'"+$sourceRoot.Replace("'","''")+"'"
foreach($variable in @($function.FindAll({param($n) $n -is [Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.UserPath -ieq 'PSScriptRoot'},$true) | Sort-Object { $_.Extent.StartOffset } -Descending)){
    $offset=$variable.Extent.StartOffset-$function.Extent.StartOffset
    $definition=$definition.Remove($offset,$variable.Extent.Text.Length).Insert($offset,$rootLiteral)
}
& {
. ([scriptblock]::Create($definition))
$probe=Join-Path $sourceRoot ('cleanup-check-'+[guid]::NewGuid().ToString('N'))
$outside=Join-Path ([IO.Path]::GetTempPath()) ('cleanup-outside-'+[guid]::NewGuid().ToString('N'))
try {
New-Item -ItemType Directory $probe | Out-Null
New-Item -ItemType Directory $outside | Out-Null
[IO.File]::WriteAllText((Join-Path $outside 'marker'),'retain')
[IO.File]::WriteAllText((Join-Path $probe 'marker'),'test')
Remove-BuildDirectory $probe
if(Test-Path $probe){throw 'Expected directory to be removed'}
$rejected=$false
try { Remove-BuildDirectory $outside } catch { $rejected=$true }
if(!$rejected -or [IO.File]::ReadAllText((Join-Path $outside 'marker')) -ne 'retain'){throw 'Out-of-scope cleanup was not safely rejected'}
New-Item -ItemType Junction -Path $probe -Target $outside | Out-Null
$rejected=$false
try { Remove-BuildDirectory $probe } catch { $rejected=$true }
if(!$rejected -or !(Test-Path -LiteralPath $probe)){throw 'Top-level junction was not rejected'}
[IO.Directory]::Delete($probe)
if((Test-Path -LiteralPath $probe) -or [IO.File]::ReadAllText((Join-Path $outside 'marker')) -ne 'retain'){throw '.NET detach damaged destination'}
'Build removal, outside-scope rejection, junction rejection and .NET detach PASS'
} finally {
foreach($fixture in @($probe,$outside)){
    $resolved=[IO.Path]::GetFullPath($fixture)
    if($resolved -ne $probe -and $resolved -ne $outside){throw 'Fixture cleanup escaped owned paths'}
    if(Test-Path -LiteralPath $resolved){
        $entry=Get-Item -LiteralPath $resolved -Force
        if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($resolved)}
        else {Remove-Item -LiteralPath $resolved -Recurse -Force}
    }
}
}
}

# Exercise the acceptance report against an empty owned installation, never production.
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('acceptance-check-'+[guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $fixture | Out-Null
    $acceptance=(Get-Content -LiteralPath (Join-Path $sourceRoot 'final-acceptance.ps1') -Raw).Replace('D:\Program Files\OctoCode',$fixture).Replace('D:\gpt-workspace\octocode',$fixture)
    $output=@(& {
        function Get-CimInstance { @() }
        & ([scriptblock]::Create($acceptance))
    } 2>&1)
    $errors=@($output | Where-Object {$_ -is [Management.Automation.ErrorRecord]})
    if($errors.Count){throw "Empty-install acceptance emitted $($errors.Count) errors: $($errors -join '; ')"}
    $report=($output -join [Environment]::NewLine) | ConvertFrom-Json
    if($report.Pass -or $report.WorkspaceCrud.Delete){throw 'Empty-install acceptance falsely passed an unexecuted operation'}
    if($null -ne $report.LatestLog -or $null -ne $report.LatestMaterializedModelConfig){throw 'Empty log/config fields should be null'}
    'Empty-install acceptance JSON, missing-runtime handling and CRUD failure PASS'
    New-Item -ItemType Directory -Path (Join-Path $fixture 'workspace') | Out-Null
    $output=@(& { function Get-CimInstance { @() }; & ([scriptblock]::Create($acceptance)) } 2>&1)
    $report=($output -join [Environment]::NewLine) | ConvertFrom-Json
    if(!$report.WorkspaceCrud.Create -or !$report.WorkspaceCrud.Update -or !$report.WorkspaceCrud.Delete){throw 'Owned workspace CRUD did not pass'}
    if(@(Get-ChildItem -LiteralPath (Join-Path $fixture 'workspace') -Force).Count){throw 'Workspace probe leaked'}
    'Owned workspace create/read-back/update/read-back/delete PASS'
} finally {
    if([IO.Path]::GetFullPath($fixture) -ne $fixture){throw 'Acceptance cleanup escaped owned fixture'}
    if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}

# Run only the retired deletion loop against owned fixtures, never the script's Apply flow.
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('retired-check-'+[guid]::NewGuid().ToString('N'))
try {
    $project=Join-Path $fixture 'project'
    $outside=Join-Path $fixture 'outside'
    $destination=Join-Path $fixture 'destination'
    New-Item -ItemType Directory -Path $project,$outside,$destination | Out-Null
    $target=Join-Path $project 'retired'
    New-Item -ItemType Junction -Path (Join-Path $outside 'keep-link') -Target $destination | Out-Null
    New-Item -ItemType Junction -Path $target -Target $outside | Out-Null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRoot 'maintenance\cleanup-retired.ps1'),[ref]$tokens,[ref]$parseErrors)
    if($parseErrors.Count){throw $parseErrors[0]}
    $evidence=Join-Path $fixture 'evidence\release'
    $failed=$false
    try { '[]' | Set-Content -LiteralPath (Join-Path $evidence 'retired-cleanup-plan.json') -Encoding UTF8 } catch { $failed=$true }
    if(!$failed){throw 'Missing evidence directory baseline did not fail'}
    $mkdir=$ast.EndBlock.Statements | Where-Object {$_.Extent.Text -like 'New-Item -ItemType Directory -Path $evidence*'}
    if(!$mkdir){throw 'Evidence directory creation missing'}
    & ([scriptblock]::Create($mkdir.Extent.Text))
    $plan=$ast.EndBlock.Statements | Where-Object {$_.Extent.Text -like '*ConvertTo-Json*retired-cleanup-plan.json*'}
    $targets=@(Join-Path $project 'retired')
    & ([scriptblock]::Create($plan.Extent.Text))
    if((Get-Content -LiteralPath (Join-Path $evidence 'retired-cleanup-plan.json') -Raw | ConvertFrom-Json) -ne $targets[0]){throw 'Cleanup plan read-back mismatch'}
    'Missing evidence directory reproduction and plan persistence PASS'
    $helper=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-CleanupTarget'},$true)
    if($helper){. ([scriptblock]::Create($helper.Extent.Text))}
    $loop=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Extent.Text -match '\$stack=New-Object'},$true)
    $targets=@($target)
    $rejected=$false
    try { & ([scriptblock]::Create($loop.Extent.Text)) } catch { $rejected=$_.Exception.Message -like 'Unexpected top-level link:*' }
    if(!$rejected -or !(Test-Path -LiteralPath (Join-Path $outside 'keep-link'))){throw 'Swapped top-level junction traversed outside cleanup scope'}
    [IO.Directory]::Delete($target)
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllText((Join-Path $destination 'marker'),'retain')
    New-Item -ItemType Junction -Path (Join-Path $target 'nested') -Target $destination | Out-Null
    $rejected=$false
    try { & ([scriptblock]::Create($loop.Extent.Text)) } catch { $rejected=$_.Exception.Message -like 'Build tree contains a reparse point:*' }
    if(!$rejected -or !(Test-Path -LiteralPath $target) -or [IO.File]::ReadAllText((Join-Path $destination 'marker')) -ne 'retain'){throw 'Retired traversal failed to reject a nested junction safely'}
    'Retired deletion revalidation and nested junction rejection PASS'
} finally {
    foreach($link in @((Join-Path $project 'retired'),(Join-Path $outside 'keep-link'))){
        if(Test-Path -LiteralPath $link){
            if((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($link)}
        }
    }
    if([IO.Path]::GetFullPath($fixture) -ne $fixture){throw 'Retired fixture cleanup escaped owned path'}
    if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
