$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\migrate-runtime-to-e.ps1'
$syntax = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
$guard = $syntax.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-Stopped' }, $true).Body.GetScriptBlock()
$install = 'E:\Program Files\octocode'
$legacy = 'D:\gpt-workspace\octocode\runtime'
function Get-CimInstance { param($ClassName) $script:fixtureProcesses }
$cases = @(
    @{ executable='E:\Program Files\octocode\test\harness2-physical-final-20261025\python\python.exe'; blocked=$false },
    @{ executable='E:\Program Files\octocode\OctoCode.exe'; blocked=$true },
    @{ executable='E:\Program Files\octocode\environments\python\python.exe'; blocked=$true },
    @{ executable='E:\Program Files\octocode\data\extensions\octocode\host.exe'; blocked=$true },
    @{ executable='D:\gpt-workspace\octocode\runtime\environments\node\node.exe'; blocked=$true },
    @{ executable='E:\Program Files\octocode-other\python.exe'; blocked=$false }
)
foreach ($case in $cases) {
    $script:fixtureProcesses = @([pscustomobject]@{ExecutablePath=$case.executable})
    $blocked = $false
    try { & $guard } catch { $blocked = $true }
    if ($blocked -ne $case.blocked) { throw "Incorrect migration process scope: $($case.executable)" }
}
'PASS: 6 migration process ownership cases; no production processes queried or changed'
