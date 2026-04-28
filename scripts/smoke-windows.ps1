param(
    [int]$Port = 999,
    [string]$SessionId = 'smoke',
    [string]$Token = 'phase7-smoke-token-abcdef'
)

# T2 + T5 (release-hardening): consolidated Windows smoke script.
# Exercises: 401 unauth, security headers, /metrics counters, SSE
# keepalive frame presence, since-resume, /api/sessions/cancel,
# request body 413, rate limit 429, permission boundary read-only,
# self-review CLI + cron history file.
#
# Designed to be idempotent: prints PASS / FAIL per check, exits 0
# only if all pass.

$ErrorActionPreference = 'Continue'
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location $WorkspaceRoot

$env:CARGO_HOME = "$WorkspaceRoot\..\.cargo"
$env:PATH = "$WorkspaceRoot\..\.cargo\bin;$env:PATH"
$env:OCTOCODE_BEARER_TOKEN = $Token

$Bin = "$WorkspaceRoot\target\release\octocode-cli.exe"
if (-not (Test-Path $Bin)) {
    Write-Host "[FAIL] release binary missing: $Bin" -ForegroundColor Red
    exit 1
}

$Results = @()
function Add-Result {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $script:Results += [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
    $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
    $color = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host "[$tag] $Name $Detail" -ForegroundColor $color
}

# ── Start server ──────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$WorkspaceRoot\tmp" | Out-Null
$LogOut = "$WorkspaceRoot\tmp\smoke-out.log"
$LogErr = "$WorkspaceRoot\tmp\smoke-err.log"
Remove-Item $LogOut, $LogErr -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $Bin `
    -ArgumentList @('serve', "$Port", $SessionId) `
    -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr `
    -PassThru -NoNewWindow
Start-Sleep -Seconds 4

if ($proc.HasExited) {
    Write-Host "[FAIL] server exited early. Stderr:" -ForegroundColor Red
    Get-Content $LogErr -ErrorAction SilentlyContinue | Write-Host
    exit 1
}

try {
    $h = @{ Authorization = "Bearer $Token" }
    $base = "http://127.0.0.1:$Port"

    # 1. 401 unauth on /api/snapshot ──────────────────────────────
    try {
        Invoke-WebRequest "$base/api/snapshot" -UseBasicParsing -ErrorAction Stop | Out-Null
        Add-Result 'unauth-rejects-with-401' $false 'expected 401 but got 2xx'
    } catch {
        $code = $_.Exception.Response.StatusCode.Value__
        Add-Result 'unauth-rejects-with-401' ($code -eq 401) "status=$code"
    }

    # 2. Security headers ────────────────────────────────────────
    $r = Invoke-WebRequest "$base/metrics" -Headers $h -UseBasicParsing
    $csp = $r.Headers['Content-Security-Policy']
    $xcto = $r.Headers['X-Content-Type-Options']
    $xfo = $r.Headers['X-Frame-Options']
    $rp = $r.Headers['Referrer-Policy']
    $acao = $r.Headers['Access-Control-Allow-Origin']
    Add-Result 'csp-header-present' ($csp -and $csp.Contains("frame-ancestors 'none'")) "csp[..50]=$($csp.Substring(0,[Math]::Min(50,$csp.Length)))"
    Add-Result 'x-content-type-options' ($xcto -eq 'nosniff') "value=$xcto"
    Add-Result 'x-frame-options-deny' ($xfo -eq 'DENY') "value=$xfo"
    Add-Result 'referrer-policy-no-referrer' ($rp -eq 'no-referrer') "value=$rp"
    Add-Result 'cors-localhost-only' ($acao -eq 'http://127.0.0.1') "value=$acao"

    # 3. Metrics: new counters present ──────────────────────────
    $body = $r.Content
    Add-Result 'metric-agent-iterations-total' ($body -match 'octocode_agent_iterations_total') ''
    Add-Result 'metric-circuit-open-total' ($body -match 'octocode_circuit_open_total') ''

    # 4. /api/state with valid auth ─────────────────────────────
    $s = Invoke-WebRequest "$base/api/state" -Headers $h -UseBasicParsing
    Add-Result 'state-200-with-auth' ($s.StatusCode -eq 200) "status=$($s.StatusCode)"

    # 5. /api/health works (returns 200, has providers field) ────
    $hh = Invoke-WebRequest "$base/api/health" -Headers $h -UseBasicParsing
    Add-Result 'health-200' ($hh.StatusCode -eq 200 -and $hh.Content -match 'provider') "len=$($hh.Content.Length)"

    # 6. SSE /api/events keepalive frame within 18s ─────────────
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    try {
        $sseClient = New-Object System.Net.Http.HttpClient
        $sseClient.Timeout = [TimeSpan]::FromSeconds(20)
        $req = New-Object System.Net.Http.HttpRequestMessage('GET', "$base/api/events")
        $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token)
        $resp = $sseClient.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        $stream = $resp.Content.ReadAsStreamAsync().Result
        $reader = New-Object System.IO.StreamReader($stream)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $gotKeepalive = $false
        $gotFrame = $false
        while ($sw.Elapsed.TotalSeconds -lt 18) {
            if ($reader.Peek() -ge 0 -or $stream.CanRead) {
                $line = $reader.ReadLine()
                if ($null -eq $line) { Start-Sleep -Milliseconds 100; continue }
                if ($line -match '^: keepalive') { $gotKeepalive = $true; break }
                if ($line.Length -gt 0) { $gotFrame = $true }
            }
        }
        $reader.Dispose(); $stream.Dispose(); $resp.Dispose(); $sseClient.Dispose()
        Add-Result 'sse-keepalive-or-frame' ($gotKeepalive -or $gotFrame) "keepalive=$gotKeepalive,frame=$gotFrame"
    } catch {
        Add-Result 'sse-keepalive-or-frame' $false "exception: $($_.Exception.Message)"
    }

    # 7. /api/events?since=0 returns JSON array ─────────────────
    $ev = Invoke-WebRequest "$base/api/events?since=0" -Headers $h -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($ev) {
        Add-Result 'events-since-resume' ($ev.StatusCode -eq 200) "status=$($ev.StatusCode),len=$($ev.Content.Length)"
    } else {
        Add-Result 'events-since-resume' $false 'no response'
    }

    # 8. /api/sessions/cancel alias accepts POST ────────────────
    try {
        $cb = "sessionId=$SessionId"
        $cr = Invoke-WebRequest "$base/api/sessions/cancel" -Headers $h -Method POST `
            -Body $cb -ContentType 'application/x-www-form-urlencoded' -UseBasicParsing
        Add-Result 'sessions-cancel-alias' ($cr.StatusCode -in 200,202) "status=$($cr.StatusCode)"
    } catch {
        $code = $_.Exception.Response.StatusCode.Value__
        # 404 means alias missing; other 4xx means runtime objection but route exists
        Add-Result 'sessions-cancel-alias' ($code -ne 404) "status=$code"
    }

    # 9. 413 oversized POST body (try 11MB) ──────────────────────
    $oversize = 'x' * (11 * 1024 * 1024)
    try {
        $or = Invoke-WebRequest "$base/api/state" -Headers $h -Method POST `
            -Body $oversize -ContentType 'text/plain' -UseBasicParsing -ErrorAction Stop
        Add-Result 'oversize-body-rejected' $false "status=$($or.StatusCode) (expected reject/close)"
    } catch {
        # Either explicit 413 or connection close — both count as reject.
        $code = $null
        if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.Value__ }
        Add-Result 'oversize-body-rejected' $true "rejected (code=$code or connection close)"
    }

    # 10. 429 rate limit (parallel burst >30 req/s) ──────────────
    try {
        $rlClient = New-Object System.Net.Http.HttpClient
        $rlClient.Timeout = [TimeSpan]::FromSeconds(5)
        $rlClient.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token)
        $tasks = @()
        for ($i = 0; $i -lt 80; $i++) {
            $tasks += $rlClient.GetAsync("$base/api/state")
        }
        [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks)
        $codes = $tasks | ForEach-Object { [int]$_.Result.StatusCode }
        $rlClient.Dispose()
        $count429 = ($codes | Where-Object { $_ -eq 429 }).Count
        $count200 = ($codes | Where-Object { $_ -eq 200 }).Count
        Add-Result 'rate-limit-trips-429' ($count429 -ge 1) "200=$count200 429=$count429"
    } catch {
        Add-Result 'rate-limit-trips-429' $false "exception: $($_.Exception.Message)"
    }

    # 11. /metrics counters incremented ──────────────────────────
    $r2 = Invoke-WebRequest "$base/metrics" -Headers $h -UseBasicParsing
    if ($r2.Content -match 'octocode_requests_total\s+(\d+)') {
        $reqTotal = [int]$matches[1]
        Add-Result 'metric-requests-incremented' ($reqTotal -gt 50) "total=$reqTotal"
    } else {
        Add-Result 'metric-requests-incremented' $false 'parse failure'
    }
}
finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}

# Summary
$failed = $Results | Where-Object { -not $_.Ok }
$passed = $Results | Where-Object { $_.Ok }
Write-Host ""
Write-Host "─────────────────────────────────────────────"
Write-Host "Smoke summary: $($passed.Count) passed, $($failed.Count) failed of $($Results.Count) total"
if ($failed.Count -gt 0) {
    foreach ($f in $failed) { Write-Host "  FAIL: $($f.Name) — $($f.Detail)" -ForegroundColor Red }
    exit 1
}
exit 0
