# Isolated regression probes; never use live registry, WSL or installed product data.
$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('desktop-storage-check-'+[guid]::NewGuid().ToString('N'))
$scriptsRoot=$PSScriptRoot
function Assert([bool]$Condition,[string]$Message){if(!$Condition){throw $Message}}
function Read-Ast([string]$Name){
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptsRoot $Name),[ref]$tokens,[ref]$errors)
    if($errors.Count){throw $errors[0]}
    return $ast
}
try {
    New-Item -ItemType Directory -Path $fixture | Out-Null
    $app=Join-Path $fixture 'app'
    $storage=Join-Path $fixture 'storage'
    & (Join-Path $scriptsRoot 'octocode-storage-layout.ps1') -AppRoot $app -StorageRoot $storage
    & (Join-Path $scriptsRoot 'octocode-storage-layout.ps1') -AppRoot $app -StorageRoot $storage
    foreach($name in @('data','workspace','environments')){
        Assert ((Get-Item -LiteralPath (Join-Path $app $name)).LinkType -eq 'Junction') "Missing junction: $name"
    }
    $rejected=$false
    try {& (Join-Path $scriptsRoot 'octocode-storage-layout.ps1') -AppRoot 'C:\' -StorageRoot $storage} catch {$rejected=$_.Exception.Message -eq 'Drive roots are not application/storage directories'}
    Assert $rejected 'Drive root guard failed'
    $rejected=$false
    try {& (Join-Path $scriptsRoot 'octocode-storage-layout.ps1') -AppRoot $app -StorageRoot (Join-Path $app 'nested')} catch {$rejected=$true}
    Assert $rejected 'Overlapping roots accepted'
    $nullTarget=[string]@($null)[0]
    Assert ($nullTarget -eq '' -and !$nullTarget.Equals($storage,[StringComparison]::OrdinalIgnoreCase)) 'Null target conversion did not reject mismatch'
    'Storage idempotence, drive-root and overlap guards PASS'

    # Simulate a late junction creation failure while retaining an existing first link.
    $partialApp=Join-Path $fixture 'partial-app'
    $partialStorage=Join-Path $fixture 'partial-storage'
    New-Item -ItemType Directory -Path $partialApp,(Join-Path $partialStorage 'data') | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $partialApp 'data') -Target (Join-Path $partialStorage 'data') | Out-Null
    [IO.File]::WriteAllText((Join-Path $partialStorage 'data\marker'),'retain')
    $rejected=$false
    try {
        & {
            function New-Item {
                param($ItemType,$Path,$Target,[switch]$Force)
                if($ItemType -eq 'Junction' -and $Path -eq (Join-Path $partialApp 'environments')){throw 'Injected junction failure'}
                $arguments=@{ItemType=$ItemType;Path=$Path;Force=$Force}
                if($Target){$arguments.Target=$Target}
                Microsoft.PowerShell.Management\New-Item @arguments
            }
            & (Join-Path $scriptsRoot 'octocode-storage-layout.ps1') -AppRoot $partialApp -StorageRoot $partialStorage
        }
    } catch {$rejected=$_.Exception.Message -eq 'Injected junction failure'}
    Assert $rejected 'Late failure was not injected'
    Assert (!(Test-Path -LiteralPath (Join-Path $partialApp 'workspace'))) 'Newly created junction leaked after failure'
    Assert (Test-Path -LiteralPath (Join-Path $partialApp 'data')) 'Pre-existing junction removed by rollback'
    Assert ([IO.File]::ReadAllText((Join-Path $partialStorage 'data\marker')) -eq 'retain') 'Storage marker changed'
    'Storage failure rollback preserves existing link/data PASS'

    # Mock registry lookup and WSL entirely; execute uninitialize with owned layout only.
    $wslBase=Join-Path $storage 'environments\wsl\OctoCode'
    New-Item -ItemType Directory -Path $wslBase | Out-Null
    [IO.File]::WriteAllText((Join-Path $wslBase 'marker'),'user WSL fixture')
    $scalarTarget=[pscustomobject]@{Target=(Join-Path $storage 'environments')}
    Assert ([string]$scalarTarget.Target[0] -ne $scalarTarget.Target) 'Original scalar Target truncation did not reproduce'
    foreach($targetShape in @('scalar','array')){
    foreach($registeredBase in @($wslBase,($wslBase+'\'),('\\?\'+$wslBase),(Join-Path $fixture 'unrelated-wsl'),$null)){
        $mockState=[pscustomobject]@{Base=$registeredBase;Calls=[Collections.Generic.List[string]]::new()}
        & {
            function Get-ChildItem {param($Path,$ErrorAction) [pscustomobject]@{DistributionName='OctoCode';BasePath=$mockState.Base}}
            function Get-ItemProperty {param([Parameter(ValueFromPipeline=$true)]$InputObject) process {$InputObject}}
            function Get-Item {
                param($LiteralPath,[switch]$Force,$ErrorAction)
                $target=Join-Path $storage 'environments'
                [pscustomobject]@{LinkType='Junction';Target=$(if($targetShape -eq 'array'){,@($target)}else{$target})}
            }
            function wsl.exe {$mockState.Calls.Add(($args -join ' ')); $global:LASTEXITCODE=0}
            & (Join-Path $scriptsRoot 'octocode-uninitialize.ps1') -AppRoot $app
        }
        $expected=if($registeredBase -eq $wslBase -or $registeredBase -eq ($wslBase+'\') -or $registeredBase -eq ('\\?\'+$wslBase)){1}else{0}
        Assert ($mockState.Calls.Count -eq $expected) "WSL ownership/target resolution mismatch: base=$registeredBase expected=$expected calls=$($mockState.Calls -join ';')"
        if($expected){Assert ($mockState.Calls[0] -eq '--terminate OctoCode') 'Uninitialize attempted destructive WSL command'}
        Assert ([IO.File]::ReadAllText((Join-Path $wslBase 'marker')) -eq 'user WSL fixture') 'WSL data changed'
        Assert (Test-Path -LiteralPath (Join-Path $app 'environments')) 'Environment junction removed'
    }
    }
    'Uninitialize matching/foreign/null BasePath and environment preservation PASS'

    $selfAst=Read-Ast 'octocode-self-test.ps1'
    $wslStatement=$selfAst.EndBlock.Statements | Where-Object {$_.Extent.Text -like '$results.wsl =*'}
    $failed=$false
    try {
        & {
            $results=[ordered]@{}; $distro=[pscustomobject]@{DistributionName='OctoCode'}
            function wsl.exe {$global:LASTEXITCODE=9; 'Injected WSL failure'}
            function Invoke-SelfTestCommand {throw 'Injected WSL failure'}
            . ([scriptblock]::Create($wslStatement.Extent.Text))
        }
    } catch {$failed=$true}
    Assert $failed 'WSL nonzero result falsely accepted by self-test'
    $commandHelper=$selfAst.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-SelfTestCommand'},$true)
    Assert ($null -ne $commandHelper) 'Bounded WSL command helper missing'
    . ([scriptblock]::Create($commandHelper.Extent.Text))
    $output=Invoke-SelfTestCommand -FilePath $env:ComSpec -Arguments '/d /c echo fixture-output' -TimeoutMilliseconds 5000
    Assert ($output.Trim() -eq 'fixture-output') 'Successful command output incorrect'
    $failed=$false
    try {Invoke-SelfTestCommand -FilePath $env:ComSpec -Arguments '/d /c exit 9' -TimeoutMilliseconds 5000 | Out-Null} catch {$failed=$_.Exception.Message -like '*exit code 9*'}
    Assert $failed 'Nonzero native exit accepted'
    $engine=(Get-Process -Id $PID).Path
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $failed=$false
    try {Invoke-SelfTestCommand -FilePath $engine -Arguments '-NoProfile -Command "Start-Sleep -Seconds 10"' -TimeoutMilliseconds 300 | Out-Null} catch {$failed=$_.Exception.Message -like '*timed out*'}
    Assert ($failed -and $clock.Elapsed.TotalSeconds -lt 5) 'Slow owned command was not bounded'
    'Self-test WSL failure propagation and owned-process timeout PASS'

    # Adjudicate endpoint/parser and Rust short-circuit allegations without running tools.
    $productJson=Join-Path $fixture 'product.json'
    $endpointStatements=$selfAst.EndBlock.Statements | Where-Object {
        $_.Extent.Text -like '$configuredUpdateUrl =*' -or $_.Extent.Text -like 'if ($configuredUpdateUrl*' -or
        $_.Extent.Text -like '$allowedEndpointHosts =*' -or $_.Extent.Text -like '$endpointUrls =*' -or
        $_.Extent.Text -like '$blockedEndpoints =*' -or $_.Extent.Text -like 'if ($blockedEndpoints*'
    }
    $endpointCode=($endpointStatements | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine
    foreach($case in @('valid','empty','blocked','invalid','invaliduri','malformed')){
        $product=@{updateUrl='https://updates.example.test';gallery='https://open-vsx.org/api'}
        if($case -eq 'empty'){$product.updateUrl=''}
        if($case -eq 'blocked'){$product.gallery='https://blocked.example.test/api'}
        if($case -eq 'invalid'){$product.updateUrl='http://updates.example.test'}
        if($case -eq 'invaliduri'){$product.updateUrl='https://[invalid'}
        $product | ConvertTo-Json | Set-Content -LiteralPath $productJson -Encoding UTF8
        if($case -eq 'malformed'){'not JSON' | Set-Content -LiteralPath $productJson}
        $rejected=$false
        try {& ([scriptblock]::Create($endpointCode))} catch {$rejected=$true}
        Assert ($rejected -eq ($case -in @('blocked','invalid','invaliduri','malformed'))) "Endpoint validation unexpected: $case"
    }
    $matches=@([regex]::Matches('{"a":"https://github.com/a","b":"https://open-vsx.org/b"}', 'https://[^"\s]+') | ForEach-Object Value)
    Assert ($matches.Count -eq 2 -and $matches[0] -eq 'https://github.com/a') 'Endpoint regex crossed quotes'
    $results=[ordered]@{rust='rustc 1.98.0'}; $toolchains=@()
    $rustGuard=$selfAst.EndBlock.Statements | Where-Object {$_.Extent.Text -like 'if ($results.Contains(''rust'') -and*'}
    $rejected=$false
    try {& ([scriptblock]::Create($rustGuard.Extent.Text))} catch {$rejected=$_.Exception.Message -like 'Expected one Rust 1.98.0 toolchain*'}
    Assert $rejected 'Empty Rust toolchain registry did not fail explicitly'
    'Self-test JSON/endpoint fail-closed checks and Rust empty-registry guard PASS'
    $environmentRoot=Join-Path $fixture 'optional-tools'
    New-Item -ItemType Directory -Path $environmentRoot | Out-Null
    $checks=[ordered]@{powershell=@('owned-tool.cmd','--version')}
    $onDemand=@{powershell='powershell'}
    $results=[ordered]@{}; $notProvisioned=[Collections.Generic.List[string]]::new()
    $toolLoop=$selfAst.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Extent.Text -like 'foreach ($entry in $checks.GetEnumerator())*'},$true)
    . ([scriptblock]::Create($toolLoop.Extent.Text))
    Assert ($notProvisioned.Count -eq 1 -and $notProvisioned[0] -eq 'powershell') 'Absent optional tool not recorded'
    [IO.File]::WriteAllText((Join-Path $environmentRoot 'owned-tool.cmd'),"@echo off`r`nexit /b 9`r`n")
    $rejected=$false
    try {. ([scriptblock]::Create($toolLoop.Extent.Text))} catch {$rejected=$_.Exception.Message -eq 'powershell self-test failed'}
    Assert $rejected 'Broken provisioned optional tool was hidden as absence'
    'Absent optional tool reporting and provisioned failure rejection PASS'
} finally {
    # Detach only fixture junctions, then remove the resolved owned root.
    foreach($ownedApp in @((Join-Path $fixture 'app'),(Join-Path $fixture 'partial-app'))){
        foreach($name in @('data','workspace','environments')){
            $link=Join-Path $ownedApp $name
            if(Test-Path -LiteralPath $link){
                if((Get-Item -LiteralPath $link -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($link)}
            }
        }
    }
    if([IO.Path]::GetFullPath($fixture) -ne $fixture){throw 'Fixture cleanup escaped owned root'}
    if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
