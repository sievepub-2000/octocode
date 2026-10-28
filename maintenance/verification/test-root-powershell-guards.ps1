param(
    [string]$SourceRoot,
    [string]$NodeExe='D:\gpt-workspace\octocode\source\desktop-shell\.build\environments\node\node.exe',
    [Parameter(Mandatory)][string]$ProbeExe,
    [string]$OwnedRoot=(Join-Path ([IO.Path]::GetTempPath()) ('octocode-root-guards-'+[guid]::NewGuid().ToString('N'))),
    [ValidateSet('All','Cleanup','Preservation','Acceptance')][string]$Case='All'
)
$ErrorActionPreference='Stop'
if(!$SourceRoot){$SourceRoot=Split-Path (Split-Path (Split-Path $PSCommandPath -Parent) -Parent) -Parent}
$testRoot=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')
if([IO.Path]::GetFileName($testRoot) -notmatch '^octocode-root-guards-[a-f0-9]{32}$' -or (Test-Path -LiteralPath $testRoot)){throw 'Expected a new GUID-owned fixture root'}
$checks=[Collections.Generic.List[object]]::new()
function Check([bool]$condition,[string]$label){$checks.Add([pscustomobject]@{label=$label;passed=$condition})}
function Reject([scriptblock]$action,[string]$pattern,[string]$label){
    $message=$null
    try {& $action | Out-Null} catch {$message=$_.Exception.Message}
    Check ($null -ne $message -and $message -match $pattern) $label
}
function Parse-Script([string]$path){
    $tokens=$null;$parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$parseErrors)
    if($parseErrors.Count){throw $parseErrors[0]}
    $ast
}
function Copy-Baseline($value){$value | ConvertTo-Json -Depth 8 | ConvertFrom-Json}
function Remove-Fixture([string]$path){
    $full=[IO.Path]::GetFullPath($path)
    if($full -ine $testRoot -and !$full.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup escaped owned root'}
    $entry=Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){
        if($entry.PSIsContainer){[IO.Directory]::Delete($full,$false)}else{[IO.File]::Delete($full)}
        return
    }
    if($entry.PSIsContainer){
        foreach($child in @(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop)){Remove-Fixture $child.FullName}
        [IO.Directory]::Delete($full,$false)
    }else{[IO.File]::Delete($full)}
}
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    . (Join-Path $SourceRoot 'build-product-safety.ps1')
    $cleanupAst=Parse-Script (Join-Path $SourceRoot 'maintenance\cleanup-retired.ps1')
    $preservationAst=Parse-Script (Join-Path $SourceRoot 'maintenance\install-current.ps1')
    foreach($ast in @($cleanupAst,$preservationAst)){
        foreach($definition in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
            . ([scriptblock]::Create($definition.Extent.Text))
        }
    }
    if($Case -in @('All','Cleanup')){
        $project=Join-Path $testRoot 'cleanup-project'
        $outside=Join-Path $testRoot 'outside'
        New-Item -ItemType Directory -Path $project,$outside | Out-Null
        $externalTarget=Join-Path $outside 'retired'
        New-Item -ItemType Directory -Path $externalTarget | Out-Null
        $sentinel=Join-Path $externalTarget 'sentinel.txt'
        [IO.File]::WriteAllText($sentinel,'retain-owned-external-sentinel')
        $sentinelHash=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
        $physical=Join-Path $project 'physical'
        New-Item -ItemType Directory -Path $physical | Out-Null
        [IO.File]::WriteAllText((Join-Path $physical 'owned.txt'),'owned')
        Assert-CleanupTarget $physical
        Check (Test-Path -LiteralPath (Join-Path $physical 'owned.txt')) 'Physical cleanup candidate accepted without mutation'
        Reject {Assert-CleanupTarget $externalTarget} 'outside project|escaped' 'Outside cleanup candidate rejected'
        $topLink=Join-Path $project 'top-link'
        New-Item -ItemType Junction -Path $topLink -Target $externalTarget | Out-Null
        Reject {Assert-CleanupTarget $topLink} 'link|reparse' 'Top-level junction rejected'
        [IO.Directory]::Delete($topLink,$false)
        $nested=Join-Path $physical 'nested-link'
        New-Item -ItemType Junction -Path $nested -Target $externalTarget | Out-Null
        Reject {Assert-CleanupTarget $physical} 'reparse' 'Child junction rejected before cleanup'
        Check ((Get-FileHash -LiteralPath $sentinel).Hash -ceq $sentinelHash) 'Child junction external sentinel unchanged'
        [IO.Directory]::Delete($nested,$false)
        $backups=Join-Path $project 'backups'
        New-Item -ItemType Junction -Path $backups -Target $outside | Out-Null
        $selection=@($cleanupAst.EndBlock.Statements | Where-Object { $_.Extent.Text -like '$targets+=Get-ChildItem*' -and $_.Extent.Text.Contains("'backups'") })
        if($selection.Count -ne 1){throw 'Unique original backups selector required'}
        $targets=@()
        . ([scriptblock]::Create($selection[0].Extent.Text))
        Check ($targets.Count -eq 1 -and $targets[0] -ieq (Join-Path $backups 'retired')) 'Original backups selector produces linked child'
        Reject {Assert-CleanupTarget $targets[0]} 'reparse' 'Ancestor junction rejected for original selector target'
        $loop=@($cleanupAst.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.ForEachStatementAst] -and $_.Extent.Text.Contains('$stack=New-Object') })
        if($loop.Count -ne 1){throw 'Unique original cleanup deletion loop required'}
        $rejected=$false
        try {& ([scriptblock]::Create($loop[0].Extent.Text))} catch {$rejected=$_.Exception.Message -match 'reparse'}
        Check ($rejected -and (Test-Path -LiteralPath $sentinel)) 'Original deletion loop refuses ancestor junction'
        Check ((Test-Path -LiteralPath $sentinel) -and (Get-FileHash -LiteralPath $sentinel).Hash -ceq $sentinelHash) 'Original loop external sentinel bytes unchanged'
        [IO.Directory]::Delete($backups,$false)
        $targets=@($physical)
        & ([scriptblock]::Create($loop[0].Extent.Text))
        Check (!(Test-Path -LiteralPath $physical)) 'Original loop removes legitimate physical owned candidate'

        # The existing manifest/current-Upgrade proof contract: 26 pure checks.
        $manifest=[pscustomobject]@{shellVersion='1.132.2';installer=[pscustomobject]@{file='OctoCodeSetup-1.132.2.exe';sha256=('A'*64)}}
        Check ((Get-CurrentInstallerFile $manifest) -ceq $manifest.installer.file) 'Upgrade26: current manifest filename accepted'
        foreach($name in @('../OctoCodeSetup-1.132.2.exe','sub\OctoCodeSetup-1.132.2.exe','D:\OctoCodeSetup-1.132.2.exe','OctoCodeSetup-1.132.2.exe:stream','OctoCodeSetup-*.exe','',"OctoCodeSetup-1.132.2.exe`n")){
            $candidate=Copy-Baseline $manifest;$candidate.installer.file=$name
            Reject {Get-CurrentInstallerFile $candidate} 'Invalid current installer filename' ('Upgrade26: unsafe filename '+$name)
        }
        $proof=[pscustomobject]@{step='Upgrade';exitCode=0;preservation='PASS';shellVersion='1.132.2';installerSha256=('a'*64)}
        Check (Test-CurrentUpgradeProof $proof $manifest '1.132.2') 'Upgrade26: bound Upgrade proof accepted'
        foreach($field in @('step','exitCode','preservation','shellVersion','installerSha256')){
            foreach($value in @($null,'wrong')){
                $candidate=Copy-Baseline $proof;$candidate.$field=$value
                Check (!(Test-CurrentUpgradeProof $candidate $manifest '1.132.2')) ('Upgrade26: invalid '+$field)
            }
        }
        foreach($version in @('','1.132.1','1.132.2.0')){Check (!(Test-CurrentUpgradeProof $proof $manifest $version)) ('Upgrade26: wrong installed version '+$version)}
        foreach($code in @(1,'0',$false)){
            $candidate=Copy-Baseline $proof;$candidate.exitCode=$code
            Check (!(Test-CurrentUpgradeProof $candidate $manifest '1.132.2')) 'Upgrade26: invalid native exit'
        }
        Check (!(Test-CurrentUpgradeProof $null $manifest '1.132.2')) 'Upgrade26: absent proof rejected'
    }
    if($Case -in @('All','Preservation')){
        $project=Join-Path $testRoot 'preservation-project'
        $runtime=Join-Path $project 'runtime'
        $install=Join-Path $testRoot 'installed'
        New-Item -ItemType Directory -Path $install | Out-Null
        foreach($name in @('data','workspace','environments')){
            $target=Join-Path $runtime $name
            New-Item -ItemType Directory -Path $target -Force | Out-Null
            New-Item -ItemType Junction -Path (Join-Path $install $name) -Target $target | Out-Null
        }
        $minimal=Copy-Baseline (Current-Preservation)
        Check ($minimal.files.Count -eq 7) 'Empty user trees still generate seven optional records including shared storage'
        Assert-Preservation $minimal
        Check $true 'Normal minimal baseline with absent optional values accepted'
        $user=Join-Path $runtime 'data\user-data\User'
        New-Item -ItemType Directory -Path $user -Force | Out-Null
        $marker=Join-Path $user 'owned-marker.txt'
        [IO.File]::WriteAllText($marker,'owned-before')
        $expected=Copy-Baseline (Current-Preservation)
        Assert-Preservation $expected
        Check $true 'Normal populated JSON baseline accepted'
        [IO.File]::WriteAllText((Join-Path $runtime 'workspace\added.txt'),'permitted-new-file')
        Assert-Preservation $expected
        Check $true 'Added files remain permitted'
        [IO.File]::WriteAllText($marker,'owned-changed')
        Reject {Assert-Preservation $expected} 'Preserved user state changed' 'Normal baseline detects existing file change'
        [IO.File]::WriteAllText($marker,'owned-before')
        foreach($shape in @('empty','missing','null','string','scalar','null-record','missing-key','blank-key','array-kind','unknown-kind','missing-value','bad-hash','duplicate-key','missing-required')){
            $bad=Copy-Baseline $expected
            switch($shape){
                'empty' {$bad.files=@()}
                'missing' {$bad.PSObject.Properties.Remove('files')}
                'null' {$bad.files=$null}
                'string' {$bad.files='not-records'}
                'scalar' {$bad.files=$bad.files[0]}
                'null-record' {$bad.files+=@($null)}
                'missing-key' {$bad.files[0].PSObject.Properties.Remove('key')}
                'blank-key' {$bad.files[0].key=' '}
                'array-kind' {$bad.files[0].kind=@($bad.files[0].kind)}
                'unknown-kind' {$bad.files[0].kind='unknown'}
                'missing-value' {$bad.files[0].PSObject.Properties.Remove('value')}
                'bad-hash' {($bad.files | Where-Object kind -eq 'file')[0].value='not-a-hash'}
                'duplicate-key' {$bad.files+=@(Copy-Baseline $bad.files[0])}
                'missing-required' {$bad.files=@($bad.files | Where-Object key -ne 'user-data/Local State')}
            }
            Reject {Assert-Preservation $bad} 'baseline|record|Preserved user state' ('Malformed baseline rejected: '+$shape)
        }
        $linked=Join-Path $runtime 'workspace\linked'
        New-Item -ItemType Junction -Path $linked -Target $user | Out-Null
        $withLink=Copy-Baseline (Current-Preservation)
        Assert-Preservation $withLink
        Check (@($withLink.files | Where-Object { $_.key -eq 'workspace/linked' -and $_.kind -eq 'link' }).Count -eq 1) 'Normal link record retained without traversal'
        Check (@($withLink.files | Where-Object key -eq 'workspace/linked/owned-marker.txt').Count -eq 0) 'Preservation does not follow nested junction'
        # Exercise the real VerifyOnly branch without Snapshot/Save-Baseline/ACL.
        $baseline=Join-Path $project 'verification\upgrade-preservation\preserved-current.json'
        New-Item -ItemType Directory -Path (Split-Path $baseline -Parent) -Force | Out-Null
        $withLink | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $baseline -Encoding UTF8
        $verified=@(& {function Get-CimInstance {@()}; & (Join-Path $SourceRoot 'maintenance\install-current.ps1') -VerifyOnly -ProjectRoot $project -InstallRoot $install})
        Check (($verified -join '') -match 'Preservation passed') 'Real VerifyOnly accepts normal baseline without installer'
        $bad=Copy-Baseline $withLink;$bad.files=@()
        $bad | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $baseline -Encoding UTF8
        Reject {& {function Get-CimInstance {@()}; & (Join-Path $SourceRoot 'maintenance\install-current.ps1') -VerifyOnly -ProjectRoot $project -InstallRoot $install}} 'baseline|record' 'Real VerifyOnly rejects malformed collection'
    }
    if($Case -in @('All','Acceptance')){
        $fixture=Join-Path $testRoot 'acceptance'
        $bin=Join-Path $fixture 'data\extensions\octocode.octocode-0.1.0\bin\win32-x64'
        $logs=Join-Path $fixture 'data\user-data\logs\20261001T000000'
        $config=Join-Path $fixture 'data\user-data\User\globalStorage\octocode.octocode\harness-runtime\sessions\owned\config.toml'
        foreach($directory in @($bin,(Join-Path $fixture 'workspace'),(Join-Path $fixture 'releases'),(Join-Path $fixture 'resources\app\extensions'),(Join-Path $fixture 'environments'),$logs,(Split-Path $config -Parent))){New-Item -ItemType Directory -Path $directory -Force | Out-Null}
        Copy-Item -LiteralPath $ProbeExe -Destination (Join-Path $bin 'octocode-harness.exe')
        [IO.File]::WriteAllText((Join-Path $bin 'octocode-host.exe'),'owned existence marker')
        [IO.File]::WriteAllText((Join-Path $bin 'code-graph.exe'),'owned index existence marker')
        [IO.File]::WriteAllText((Join-Path $fixture 'OctoCode.exe'),'owned existence marker')
        [IO.File]::WriteAllText((Join-Path $fixture 'releases\release-manifest.json'),'{"version":"0.1.0"}')
        New-Item -ItemType Junction -Path (Join-Path $fixture 'environments\node') -Target (Split-Path $NodeExe -Parent) | Out-Null
        [IO.File]::WriteAllText((Join-Path $logs 'main.log'),'clean-owned-log')
        [IO.File]::WriteAllText($config,'# owned presence-only fixture, no model endpoint')
        $text=[IO.File]::ReadAllText((Join-Path $SourceRoot 'final-acceptance.ps1'))
        $text=$text.Replace('E:\Program Files\octocode','__OWNED_INSTALL__').Replace('D:\gpt-workspace\octocode','__OWNED_PROJECT__')
        if($text.Contains('E:\Program Files\octocode') -or $text.Contains('D:\gpt-workspace\octocode')){throw 'Production path remained before rebinding'}
        $text=$text.Replace('__OWNED_INSTALL__',$fixture).Replace('__OWNED_PROJECT__',$fixture)
        function Read-Acceptance {
            $output=@(& {function Get-CimInstance {@()}; & ([scriptblock]::Create($text))} 2>&1)
            $errors=@($output | Where-Object {$_ -is [Management.Automation.ErrorRecord]})
            if($errors.Count){throw ('Acceptance fixture emitted errors: '+($errors -join '; '))}
            ($output -join [Environment]::NewLine) | ConvertFrom-Json
        }
        $mode=Join-Path $bin 'owned-probe-mode.txt'
        [IO.File]::WriteAllText($mode,'0|octocode-harness owned-probe')
        $report=Read-Acceptance
        Check ($report.Pass -and $report.Failures.Count -eq 0) 'Presence-only acceptance succeeds with native exit zero'
        [IO.File]::WriteAllText($mode,'9|octocode-harness owned-probe')
        $report=Read-Acceptance
        Check (!$report.Pass -and @($report.Failures | Where-Object {$_ -match 'harness.*exit.*9'}).Count -eq 1) 'Matching harness stdout with native exit 9 fails acceptance'
        [IO.File]::WriteAllText($mode,'0|incorrect-identity')
        $report=Read-Acceptance
        Check (!$report.Pass -and @($report.Failures | Where-Object {$_ -match 'self-identify'}).Count -eq 1) 'Native exit zero still requires harness identity'
        [IO.File]::WriteAllText($mode,'0|octocode-harness owned-probe')
        Remove-Fixture (Split-Path $logs -Parent)
        $report=Read-Acceptance
        Check (!$report.Pass -and @($report.Failures | Where-Object {$_ -match 'missing.*log'}).Count -eq 1) 'Missing logs is a real failure'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $logs 'main.log'),'clean-owned-log')
        [IO.File]::Delete($config)
        $report=Read-Acceptance
        Check (!$report.Pass -and @($report.Failures | Where-Object {$_ -match 'missing.*materialized'}).Count -eq 1) 'Missing materialized config is a real failure'
        [IO.File]::WriteAllText($config,'# owned presence-only fixture')
        [IO.File]::WriteAllText((Join-Path $logs 'main.log'),'[warning] owned negative control')
        $report=Read-Acceptance
        Check (!$report.Pass -and $report.ErrorsOrWarnings.Count -eq 1) 'Existing warning gate still rejects warnings'
        Check (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'workspace') -Force).Count -eq 0) 'Acceptance CRUD probes leave no owned workspace files'
    }
    $failed=@($checks | Where-Object {!$_.passed})
    [pscustomobject]@{engine=$PSVersionTable.PSVersion.ToString();case=$Case;passed=$checks.Count-$failed.Count;failed=$failed.Count;upgradeProof26=@($checks | Where-Object { $_.label -like 'Upgrade26:*' -and $_.passed }).Count;checks=@($checks);installerInvocations=0;applyInvocations=0;aclChanges=0;coldStartVerified=$false;freshness='pending'} | ConvertTo-Json -Depth 6 -Compress
    if($failed.Count){throw ('Focused guard checks failed: '+($failed.label -join '; '))}
} finally {if(Test-Path -LiteralPath $testRoot){Remove-Fixture $testRoot}}
