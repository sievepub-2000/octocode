# scripts/switch-provider.ps1
# One-shot helper to switch octocode's active provider config.
# Usage:
#   .\scripts\switch-provider.ps1 -Profile openrouter           # use OpenRouter (treated as 'OpenRelay')
#   .\scripts\switch-provider.ps1 -Profile local                # use http://192.168.110.2:8000
#   .\scripts\switch-provider.ps1 -Profile openrouter -ApiKey 'sk-or-...'
#   .\scripts\switch-provider.ps1 -Profile openrouter -Model 'openai/gpt-5.5-pro'
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('openrouter', 'local', 'restore-local')]
  [string]$Profile,

  [string]$Model,
  [string]$ApiKey
)

$ErrorActionPreference = 'Stop'
$confDir  = Join-Path $env:APPDATA 'octocode'
$confPath = Join-Path $confDir 'octocode.conf'
if (!(Test-Path $confDir)) { New-Item -ItemType Directory -Force -Path $confDir | Out-Null }

# Snapshot current config before overwrite
if (Test-Path $confPath) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bk = Join-Path $confDir "backups/$stamp"
  New-Item -ItemType Directory -Force -Path $bk | Out-Null
  Copy-Item $confPath (Join-Path $bk 'octocode.conf')
  Write-Host "Snapshotted current config to $bk\octocode.conf"
}

switch ($Profile) {
  'openrouter' {
    if (-not $Model) { $Model = 'anthropic/claude-opus-4.7' }
    @"
# Octocode config -- OpenRouter (alias: OpenRelay)
provider_id=openrouter
provider_base_url=https://openrouter.ai/api/v1
default_model=$Model
permission_mode=workspace-write
history_limit=20
denied_tools=
request_timeout_secs=90
"@ | Set-Content -Path $confPath -Encoding UTF8
    if ($ApiKey) {
      [Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', $ApiKey, 'User')
      $env:OPENROUTER_API_KEY = $ApiKey
      Write-Host "Stored OPENROUTER_API_KEY at User scope (length=$($ApiKey.Length))."
    } else {
      Write-Host "WARN: No -ApiKey supplied. Set `$env:OPENROUTER_API_KEY before running octocode-cli serve."
    }
    Write-Host "Switched to OpenRouter, model=$Model"
  }
  { $_ -in @('local', 'restore-local') } {
    @"
# Octocode config -- local OpenAI-compatible server
provider_id=local-openai
provider_base_url=http://192.168.110.2:8000/v1
default_model=gemma-4-31b-it-q8-prod
permission_mode=workspace-write
history_limit=20
denied_tools=
request_timeout_secs=90
"@ | Set-Content -Path $confPath -Encoding UTF8
    Write-Host "Restored local-openai (http://192.168.110.2:8000)."
  }
}

Write-Host "Active config:"
Get-Content $confPath
