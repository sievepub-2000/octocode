# scripts/test-provider.ps1
# Sends a tiny chat-completion to whichever provider/model the active octocode.conf points at.
# For OpenRouter, uses $env:OPENROUTER_API_KEY (or -ApiKey).
param(
  [string]$ApiKey,
  [string]$Model,
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$conf = Get-Content (Join-Path $env:APPDATA 'octocode/octocode.conf') | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' }
$kv = @{}
foreach ($line in $conf) { $p = $line -split '=', 2; $kv[$p[0].Trim()] = $p[1].Trim() }
$base = $kv['provider_base_url']
$providerId = $kv['provider_id']
if (-not $Model) { $Model = $kv['default_model'] }

$headers = @{ 'Content-Type' = 'application/json' }
if ($providerId -eq 'openrouter') {
  if (-not $ApiKey) { $ApiKey = $env:OPENROUTER_API_KEY }
  if (-not $ApiKey) { Write-Host "ERROR: OPENROUTER_API_KEY missing"; exit 2 }
  $headers['Authorization'] = "Bearer $ApiKey"
  $headers['HTTP-Referer']  = 'https://github.com/sievepub-2000/octocode'
  $headers['X-Title']       = 'octocode'
}

$body = @{
  model      = $Model
  messages   = @(@{role = 'user'; content = "Reply with exactly: OCTOCODE-OK" })
  max_tokens = 16
  stream     = $false
} | ConvertTo-Json -Compress -Depth 5

$url = "$base/chat/completions"
Write-Host "POST $url"
Write-Host "  provider_id=$providerId model=$Model"

try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-WebRequest -Uri $url -Method POST -Headers $headers -Body $body -TimeoutSec $TimeoutSec -UseBasicParsing
  $sw.Stop()
  $j = $r.Content | ConvertFrom-Json
  $msg = $j.choices[0].message.content
  Write-Host "HTTP $($r.StatusCode) in $($sw.ElapsedMilliseconds)ms"
  Write-Host "Reply: $msg"
  if ($msg -match 'OCTOCODE-OK|OK') { Write-Host "PASS"; exit 0 } else { Write-Host "WARN: unexpected reply"; exit 1 }
}
catch {
  Write-Host "FAIL: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host $reader.ReadToEnd()
  }
  exit 1
}
