# scripts/switch-provider.ps1
# One-shot helper to switch octocode's active provider config.
# Usage:
#   .\scripts\switch-provider.ps1 -Profile openrouter
#   .\scripts\switch-provider.ps1 -Profile local
#   .\scripts\switch-provider.ps1 -Profile openrelay
#   .\scripts\switch-provider.ps1 -Profile openrelay -SubRoute kiro -Model claude-sonnet-4.5
#   .\scripts\switch-provider.ps1 -Profile fcc                       # free-claude-code (Anthropic-only proxy; warning emitted)
#   .\scripts\switch-provider.ps1 -Profile nvidia-nim                # NVIDIA NIM direct (OpenAI compatible)
#   .\scripts\switch-provider.ps1 -Profile nvidia-nim -Model deepseek-ai/deepseek-v3.2 -ApiKey nvapi-...
#   .\scripts\switch-provider.ps1 -Profile openrouter -ApiKey 'sk-or-...' -Model 'openai/gpt-5.5-pro'
#   .\scripts\switch-provider.ps1 -Profile profile-id -ProfileId 60-fcc-nvidia-nim-glm47
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('openrouter', 'local', 'restore-local', 'openrelay', 'fcc', 'nvidia-nim', 'profile-id')]
  [string]$Profile,

  [string]$Model,
  [string]$ApiKey,
  [string]$SubRoute,
  [string]$OpenRelayHost = 'http://localhost:18765',
  [string]$FccHost       = 'http://localhost:8082',
  [string]$ProfileId
)

$ErrorActionPreference = 'Stop'
$confDir  = Join-Path $env:APPDATA 'octocode'
$confPath = Join-Path $confDir 'octocode.conf'
if (!(Test-Path $confDir)) { New-Item -ItemType Directory -Force -Path $confDir | Out-Null }

if (Test-Path $confPath) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bk = Join-Path $confDir "backups/$stamp"
  New-Item -ItemType Directory -Force -Path $bk | Out-Null
  Copy-Item $confPath (Join-Path $bk 'octocode.conf')
  Write-Host "Snapshotted current config to $bk\octocode.conf"
}

function Write-Conf {
  param([string]$ProviderId, [string]$BaseUrl, [string]$ModelName)
  @"
# Octocode config -- written by scripts/switch-provider.ps1
provider_id=$ProviderId
provider_base_url=$BaseUrl
default_model=$ModelName
permission_mode=workspace-write
history_limit=20
denied_tools=
request_timeout_secs=90
"@ | Set-Content -Path $confPath -Encoding UTF8
}

switch ($Profile) {
  'openrouter' {
    if (-not $Model) { $Model = 'anthropic/claude-opus-4.7' }
    Write-Conf -ProviderId 'openrouter' -BaseUrl 'https://openrouter.ai/api/v1' -ModelName $Model
    if ($ApiKey) {
      [Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', $ApiKey, 'User')
      $env:OPENROUTER_API_KEY = $ApiKey
      Write-Host "Stored OPENROUTER_API_KEY at User scope."
    } else {
      Write-Host "WARN: No -ApiKey supplied. Set `$env:OPENROUTER_API_KEY before serve."
    }
    Write-Host "Switched to OpenRouter, model=$Model"
  }
  { $_ -in @('local', 'restore-local') } {
    Write-Conf -ProviderId 'local-openai' -BaseUrl 'http://192.168.110.2:8000/v1' -ModelName 'gemma-4-31b-it-q8-prod'
    Write-Host "Restored local-openai (http://192.168.110.2:8000)."
  }
  'openrelay' {
    if (-not $SubRoute) { $SubRoute = 'kiro' }
    if (-not $Model) {
      switch ($SubRoute) {
        'kiro'        { $Model = 'claude-sonnet-4.5' }
        'gemini'      { $Model = 'gemini-2.5-pro' }
        'deepseek'    { $Model = 'deepseek-reasoner' }
        'openrouter'  { $Model = 'anthropic/claude-opus-4.7' }
        'nvidia'      { $Model = 'deepseek-ai/deepseek-v3.2' }
        'moonshot'    { $Model = 'kimi-k2-thinking' }
        'siliconflow' { $Model = 'Qwen/Qwen3-Coder-480B-A35B-Instruct' }
        'groq'        { $Model = 'llama-3.3-70b-versatile' }
        default       { $Model = 'auto' }
      }
    }
    $base = "$OpenRelayHost/$SubRoute/v1"
    Write-Conf -ProviderId 'local-openai' -BaseUrl $base -ModelName $Model
    Write-Host "Switched to OpenRelay sub=$SubRoute base=$base model=$Model"
    Write-Host "NOTE: requires OpenRelay binary running on $OpenRelayHost (https://github.com/romgX/openrelay)."
  }
  'fcc' {
    Write-Warning "free-claude-code exposes /v1/messages (Anthropic format). Octocode is OpenAI-Chat-Completions; direct use will fail."
    Write-Warning "Recommended: use -Profile nvidia-nim or one of the saved provider-profiles.json entries 60-74 instead."
    if (-not $Model) { $Model = 'nvidia_nim/z-ai/glm4.7' }
    Write-Conf -ProviderId 'anthropic' -BaseUrl "$FccHost" -ModelName $Model
    Write-Host "Switched to free-claude-code anthropic-style endpoint, model=$Model (likely incompatible)."
  }
  'nvidia-nim' {
    if (-not $Model) { $Model = 'z-ai/glm4.7' }
    Write-Conf -ProviderId 'local-openai' -BaseUrl 'https://integrate.api.nvidia.com/v1' -ModelName $Model
    if ($ApiKey) {
      [Environment]::SetEnvironmentVariable('NVIDIA_NIM_API_KEY', $ApiKey, 'User')
      [Environment]::SetEnvironmentVariable('OCTOCODE_API_KEY',   $ApiKey, 'User')
      $env:NVIDIA_NIM_API_KEY = $ApiKey
      $env:OCTOCODE_API_KEY   = $ApiKey
      Write-Host "Stored NVIDIA_NIM_API_KEY + OCTOCODE_API_KEY at User scope."
    } else {
      Write-Host "WARN: No -ApiKey supplied. Get one from https://build.nvidia.com/settings/api-keys and set `$env:OCTOCODE_API_KEY (and NVIDIA_NIM_API_KEY) before serve."
    }
    Write-Host "Switched to NVIDIA NIM direct, model=$Model"
  }
  'profile-id' {
    if (-not $ProfileId) { throw "-ProfileId required when -Profile profile-id." }
    $profilesPath = Join-Path $confDir 'provider-profiles.json'
    if (!(Test-Path $profilesPath)) { throw "$profilesPath not found." }
    $doc = Get-Content $profilesPath -Raw | ConvertFrom-Json
    $hit = $doc.profiles | Where-Object { $_.id -eq $ProfileId }
    if (-not $hit) { throw "Profile '$ProfileId' not found." }
    if (-not $Model) { $Model = $hit.defaultModel }
    Write-Conf -ProviderId $hit.providerId -BaseUrl $hit.providerBaseUrl -ModelName $Model
    if ($ApiKey) {
      [Environment]::SetEnvironmentVariable('OCTOCODE_API_KEY', $ApiKey, 'User')
      $env:OCTOCODE_API_KEY = $ApiKey
    }
    Write-Host "Switched to profile id=$ProfileId provider=$($hit.providerId) base=$($hit.providerBaseUrl) model=$Model"
  }
}

Write-Host "Active config:"
Get-Content $confPath
