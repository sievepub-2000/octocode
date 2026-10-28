$ErrorActionPreference='Stop'
. (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'build-log-policy.ps1')
$fixture=Join-Path $PSScriptRoot ('log-policy-fixture-'+[guid]::NewGuid().ToString('N'))
$log=Join-Path $fixture 'build[1].log'
$checks=0
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    foreach($text in @('Build succeeded','0 warnings','Finished with 0 warnings','  Compressing: warnings.txt','webview:lint: $ eslint src --max-warnings=0')){
        Set-Content -LiteralPath $log -Value $text
        Assert-CleanBuildLog -Log $log
        $checks++
    }
    foreach($text in @('WARNING: broken dependency','Using fallback cache','fallback: old provider','eslint --max-warnings=0 WARNING: real issue')){
        Set-Content -LiteralPath $log -Value $text
        $rejected=$false
        try {Assert-CleanBuildLog -Log $log} catch {$rejected=$true}
        if(!$rejected){throw 'Warning/fallback incorrectly accepted'}
        $checks++
    }
    $savedPreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'; $rejected=$false
        try {Assert-CleanBuildLog -Log (Join-Path $fixture 'absent.log')} catch {$rejected=$true}
        if(!$rejected){throw 'Missing log accepted with Continue preference'}
        $checks++
    } finally {$ErrorActionPreference=$savedPreference}
} finally {
    if(Test-Path -LiteralPath $log){Remove-Item -LiteralPath $log -Force}
    if(Test-Path -LiteralPath $fixture){[IO.Directory]::Delete($fixture)}
}
"Build log policy $checks checks PASS"
