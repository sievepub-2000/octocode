param([string]$Helper=(Join-Path (Split-Path $PSScriptRoot -Parent) 'install-current.ps1'))
$ErrorActionPreference='Stop'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('octocode-upgrade-test-'+[guid]::NewGuid().ToString('N'))
$project=Join-Path $testRoot 'project';$install=Join-Path $testRoot 'installed'
$passed=0
function Check([bool]$condition,[string]$label){if(!$condition){throw "FAIL: $label"};$script:passed++}
function Reject([scriptblock]$action,[string]$pattern){
    $errorMessage=$null
    try {& $action | Out-Null} catch {$errorMessage=$_.Exception.Message}
    Check ($errorMessage -and $errorMessage -match $pattern) 'Expected refusal without invoking installer'
}
function Remove-Fixture([string]$path){
    $full=[IO.Path]::GetFullPath($path)
    if($full -ne $testRoot -and !$full.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup escaped fixture'}
    $entry=Get-Item -LiteralPath $path -Force
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($path,$false);return}
    if($entry.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $path -Force)){Remove-Fixture $child.FullName};[IO.Directory]::Delete($path,$false)}else{[IO.File]::Delete($path)}
}
try {
    New-Item -ItemType Directory -Path $install -Force | Out-Null
    foreach($name in @('data','workspace','environments')){
        $target=Join-Path $project ('runtime\'+$name)
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        New-Item -ItemType Junction -Path (Join-Path $install $name) -Target $target | Out-Null
    }
    $user=Join-Path $project 'runtime\data\user-data\User'
    foreach($relative in @('profiles\private-profile','globalStorage\octocode.octocode\settings','workspaceStorage\owned-task')){New-Item -ItemType Directory -Path (Join-Path $user $relative) -Force | Out-Null}
    $settings=Join-Path $user 'profiles\private-profile\settings.json'
    [IO.File]::WriteAllText($settings,'{"profile":"owned-test"}')
    $credential=Join-Path $user 'globalStorage\state.vscdb'
    [IO.File]::WriteAllText($credential,'opaque-owned-credential-fixture-not-a-real-key')
    $task=Join-Path $user 'globalStorage\octocode.octocode\octocode.db'
    [IO.File]::WriteAllText($task,'owned-session-task-fixture')
    $workspace=Join-Path $project 'runtime\workspace\new-project.txt'
    [IO.File]::WriteAllText($workspace,'new artifact, absent from historical manifests')
    $outside=Join-Path $testRoot 'outside-link-target';New-Item -ItemType Directory -Path $outside | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $project 'runtime\workspace\linked-project') -Target $outside | Out-Null
    [IO.File]::WriteAllText((Join-Path $outside 'outside.txt'),'not followed')
    & $Helper -Step Snapshot -ProjectRoot $project -InstallRoot $install | Out-Null
    $baseline=Join-Path $project 'verification\upgrade-preservation\preserved-current.json'
    $snapshot=Get-Content -LiteralPath $baseline -Raw -Encoding UTF8 | ConvertFrom-Json
    Check (@($snapshot.files | Where-Object key -eq 'workspace/new-project.txt').Count -eq 1) 'Discover actual workspace, no legacy file list'
    Check (@($snapshot.files | Where-Object key -like '*private-profile/settings.json').Count -eq 1) 'Discover non-default profiles'
    Check (@($snapshot.files | Where-Object key -like '*state.vscdb').Count -eq 1) 'Fingerprint encrypted credential storage without printing values'
    Check (@($snapshot.files | Where-Object key -like '*octocode.db').Count -eq 1) 'Discover current task/session store'
    Check (@($snapshot.files | Where-Object key -like '*outside.txt').Count -eq 0) 'Do not follow workspace links'
    Check ((Get-Acl -LiteralPath (Split-Path $baseline -Parent)).AreAccessRulesProtected) 'Private evidence ACL'
    & $Helper -VerifyOnly -ProjectRoot $project -InstallRoot $install | Out-Null
    $passed++
    [IO.File]::WriteAllText((Join-Path $project 'runtime\workspace\added-default.txt'),'permitted new file')
    & $Helper -VerifyOnly -ProjectRoot $project -InstallRoot $install | Out-Null
    $passed++
    foreach($file in @($settings,$credential,$task,$workspace)){
        $original=[IO.File]::ReadAllText($file);[IO.File]::WriteAllText($file,'changed-fixture')
        Reject {& $Helper -VerifyOnly -ProjectRoot $project -InstallRoot $install} 'Preserved user state changed'
        [IO.File]::WriteAllText($file,$original)
    }
    $original=[IO.File]::ReadAllText($workspace);[IO.File]::Delete($workspace)
    Reject {& $Helper -VerifyOnly -ProjectRoot $project -InstallRoot $install} 'Preserved user state changed'
    [IO.File]::WriteAllText($workspace,$original)
    # Default Upgrade must refuse an absent installed executable before release lookup.
    Reject {& $Helper -ProjectRoot $project -InstallRoot $install} 'Upgrade requires an existing'
    Reject {& $Helper -Step Install -ProjectRoot $project -InstallRoot $install} 'Clean Install is retired'
    $errors=$null;$tokens=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Helper,[ref]$tokens,[ref]$errors)
    Check (!$errors.Count) 'Helper parser'
    $definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Normalize-Target'},$false)[0]
    . ([scriptblock]::Create($definition.Extent.Text))
    $path=Join-Path $project 'runtime\data'
    Check ((Normalize-Target $path) -eq $path) 'String junction target'
    Check ((Normalize-Target @($path)) -eq $path) 'PS5/PS7 array junction target'
    Check ((Normalize-Target @($path,'ignored-second-target')) -eq $path) 'Select first target, not System.Object[]'
    $text=Get-Content -LiteralPath $Helper -Raw
    Check ($text -notmatch 'Stop-Process|taskkill|Remove-Item.*install|/TASKS=|MERGETASKS') 'No process stopping/clean reinstall/forced tasks'
    Check ($text.Contains('$uninstall=$Step -eq ''Uninstall''')) 'Uninstaller requires explicit historical manual Step'
    $assignment=$ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$result'},$false)
    Check ($assignment.Count -eq 1) 'Unique emitted native result contract'
    # Contract serialization only: no fake installer pass is emitted to a log.
    $process=[pscustomobject]@{ExitCode=0};$Step='Upgrade';$uninstall=$false;$version='1.132.2'
    $manifest=[pscustomobject]@{installer=[pscustomobject]@{sha256=('A'*64)}}
    . ([scriptblock]::Create($assignment[0].Extent.Text))
    Check ($result.step -eq 'Upgrade' -and $result.exitCode -eq 0 -and $result.preservation -eq 'PASS') 'Upgrade result success fields'
    Check ($result.shellVersion -eq $version -and $result.installerSha256 -eq $manifest.installer.sha256) 'Cleanup proof bound to promoted version/hash'
    $Step='Uninstall';$uninstall=$true
    . ([scriptblock]::Create($assignment[0].Extent.Text))
    Check ($null -eq $result.shellVersion -and $null -eq $result.installerSha256 -and $result.preservation -ne 'PASS') 'Manual uninstall cannot satisfy upgrade cleanup gate'
    Check ($text.Contains('Installed executable version differs from promoted shellVersion')) 'Installed EXE version gate before result emission'
    [pscustomobject]@{engine=$PSVersionTable.PSVersion.ToString();passed=$passed;installerInvocations=0;productionChanges=0} | ConvertTo-Json -Compress
} finally {if(Test-Path -LiteralPath $testRoot){Remove-Fixture $testRoot}}
