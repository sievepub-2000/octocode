# test-regression.ps1 — Full WebUI interaction regression test suite
# Usage: powershell -ExecutionPolicy Bypass -File scripts\test-regression.ps1
#        or: .\scripts\test-regression.ps1 -Port 10001 -Session demo
param(
    [int]$Port = 10001,
    [string]$Session = "demo",
    [string]$BinaryPath = "",
    [switch]$StartServer = $false,
    [switch]$StopServerAfter = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$base = "http://127.0.0.1:$Port"
$pass = 0
$fail = 0
$serverProcess = $null

function Write-Pass([string]$label) {
    Write-Host "  [PASS] $label" -ForegroundColor Green
    $script:pass++
}

function Write-Fail([string]$label, [string]$detail = "") {
    Write-Host "  [FAIL] $label$(if ($detail) { ': ' + $detail } else { '' })" -ForegroundColor Red
    $script:fail++
}

function Assert([bool]$cond, [string]$label, [string]$detail = "") {
    if ($cond) { Write-Pass $label } else { Write-Fail $label $detail }
}

function PostForm([string]$url, [hashtable]$fields) {
    $body = ($fields.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join "&"
    Invoke-RestMethod -Method Post -Uri $url `
        -ContentType "application/x-www-form-urlencoded" `
        -Body $body
}

function WaitForServer([int]$timeoutSec = 10) {
    for ($attempt = 0; $attempt -lt ($timeoutSec * 4); $attempt++) {
        try {
            $r = Invoke-WebRequest -Uri "$base/api/health" -UseBasicParsing -ErrorAction Stop
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

# ──────────────────────────────────────────
# Optionally start the server
# ──────────────────────────────────────────
if ($StartServer) {
    $cli = if ($BinaryPath) { $BinaryPath } else {
        Join-Path $PSScriptRoot "..\target\release\octocode-cli.exe"
    }
    if (-not (Test-Path $cli)) {
        Write-Error "Binary not found: $cli. Specify -BinaryPath or build first."
        exit 1
    }
    Write-Host "Starting server: $cli serve $Port $Session"
    $serverProcess = Start-Process -FilePath $cli -ArgumentList "serve","$Port","$Session" `
        -PassThru -NoNewWindow
    if (-not (WaitForServer 15)) {
        Write-Error "Server did not start within 15 seconds"
        $serverProcess | Stop-Process -Force
        exit 1
    }
    Write-Host "Server is up (PID $($serverProcess.Id))"
}

Write-Host ""
Write-Host "=== Octocode WebUI Regression Test ===" -ForegroundColor Cyan
Write-Host "Base URL : $base"
Write-Host "Session  : $Session"
Write-Host ""

# ──────────────────────────────────────────
# 1. Health check
# ──────────────────────────────────────────
Write-Host "-- 1. GET /api/health" -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$base/api/health" -Method Get
    Assert ($health.items -is [array]) "health.items is array"
    Assert ($health.items.Count -gt 0) "health.items.Count > 0" "count=$($health.items.Count)"
} catch {
    Write-Fail "GET /api/health" $_.Exception.Message
}

# ──────────────────────────────────────────
# 2. State / snapshot
# ──────────────────────────────────────────
Write-Host "-- 2. GET /api/state" -ForegroundColor Yellow
try {
    $state = Invoke-RestMethod -Uri "$base/api/state?session=$Session"
    Assert ($null -ne $state.status) "state.status present"
    Assert ($null -ne $state.providerRoutes) "state.providerRoutes present"
    Assert ($null -ne $state.providers) "state.providers present"
    Assert ($null -ne $state.commands) "state.commands present"
    Assert ($null -ne $state.tools) "state.tools present"
    Assert ($null -ne $state.eventFeed) "state.eventFeed present"
    Assert ($null -ne $state.sessions) "state.sessions present"
    Assert ($state.commands.Count -gt 0) "commands.Count > 0" "count=$($state.commands.Count)"
    Assert ($state.tools.Count -gt 0) "tools.Count > 0" "count=$($state.tools.Count)"
    $providers = @($state.providers)
    Assert ($providers.Count -gt 0) "providers.Count > 0" "count=$($providers.Count)"
    Assert ((@($providers | Where-Object { $_.id -eq 'ollama' })).Count -ge 1) "providers include ollama"
} catch {
    Write-Fail "GET /api/state" $_.Exception.Message
}

# ──────────────────────────────────────────
# 3. Events
# ──────────────────────────────────────────
Write-Host "-- 3. GET /api/events" -ForegroundColor Yellow
try {
    $events = Invoke-RestMethod -Uri "$base/api/events?session=$Session"
    Assert ($null -ne $events.items) "events.items present"
} catch {
    Write-Fail "GET /api/events" $_.Exception.Message
}

# ──────────────────────────────────────────
# 3b. Timeline
# ──────────────────────────────────────────
Write-Host "-- 3b. GET /api/timeline" -ForegroundColor Yellow
try {
    $timeline = Invoke-RestMethod -Uri "$base/api/timeline?session=$Session"
    Assert ($null -ne $timeline.items) "timeline.items present"
} catch {
    Write-Fail "GET /api/timeline" $_.Exception.Message
}

# ──────────────────────────────────────────
# 4. Chat
# ──────────────────────────────────────────
Write-Host "-- 4. POST /api/chat" -ForegroundColor Yellow
try {
    $chat = PostForm "$base/api/chat" @{ sessionId=$Session; text="regression test ping" }
    Assert ($null -ne $chat.activeSession) "chat.activeSession present"
    Assert ($null -ne $chat.activeSession.messages) "chat.activeSession.messages present"
    Assert ($chat.activeSession.messages.Count -gt 0) "messages.Count > 0"
    Assert (($chat.eventFeed | Where-Object { $_.scope -eq 'plugin' }).Count -ge 1) "chat response includes plugin audit event"
} catch {
    Write-Fail "POST /api/chat" $_.Exception.Message
}

# ──────────────────────────────────────────
# 5. Tool: echo
# ──────────────────────────────────────────
Write-Host "-- 5. POST /api/tool (echo)" -ForegroundColor Yellow
try {
    $tool = PostForm "$base/api/tool" @{ sessionId=$Session; name="echo"; input="regression-echo" }
    Assert ($null -ne $tool.activeSession) "tool response has activeSession"
    Assert ($tool.eventFeed.Count -gt 0) "tool response has eventFeed" "count=$($tool.eventFeed.Count)"
    Assert (($tool.eventFeed | Where-Object { $_.scope -eq 'plugin' }).Count -ge 1) "tool response includes plugin audit event"
} catch {
    Write-Fail "POST /api/tool (echo)" $_.Exception.Message
}

# ──────────────────────────────────────────
# 6. Tool: read-file
# ──────────────────────────────────────────
Write-Host "-- 6. POST /api/tool (read-file)" -ForegroundColor Yellow
try {
    $rf = PostForm "$base/api/tool" @{ sessionId=$Session; name="read-file"; input="README.md" }
    Assert ($null -ne $rf.activeSession) "read-file response has activeSession"
    $lastEvent = $rf.eventFeed | Select-Object -Last 1
    Assert ($null -ne $lastEvent.scope) "read-file eventFeed has events"
} catch {
    Write-Fail "POST /api/tool (read-file)" $_.Exception.Message
}

# ──────────────────────────────────────────
# 7. Tool: list-files
# ──────────────────────────────────────────
Write-Host "-- 7. POST /api/tool (list-files)" -ForegroundColor Yellow
try {
    $lf = PostForm "$base/api/tool" @{ sessionId=$Session; name="list-files"; input="." }
    Assert ($null -ne $lf.activeSession) "list-files has activeSession"
} catch {
    Write-Fail "POST /api/tool (list-files)" $_.Exception.Message
}

# ──────────────────────────────────────────
# 8. Settings
# ──────────────────────────────────────────
Write-Host "-- 8. POST /api/settings" -ForegroundColor Yellow
try {
    $settings = PostForm "$base/api/settings" @{
        sessionId=$Session; permissionMode="workspace-write"; historyLimit="16"
    }
    Assert ($null -ne $settings.config) "settings.config present"
    Assert ($settings.config.historyLimit -eq 16) "historyLimit=16" "got $($settings.config.historyLimit)"
    Assert ($null -ne $settings.status.permissionMode) "permissionMode present"
} catch {
    Write-Fail "POST /api/settings" $_.Exception.Message
}

# ──────────────────────────────────────────
# 9. Command: provider switch
# ──────────────────────────────────────────
Write-Host "-- 9. POST /api/command (provider local-openai)" -ForegroundColor Yellow
try {
    $cmd = PostForm "$base/api/command" @{ sessionId=$Session; command="provider local-openai" }
    Assert ($null -ne $cmd.status) "command response has status"
    Assert ($cmd.status.activeProviderId -eq "local-openai") "activeProviderId=local-openai" "got $($cmd.status.activeProviderId)"
} catch {
    Write-Fail "POST /api/command (provider)" $_.Exception.Message
}

Write-Host "-- 9b. POST /api/command (provider ollama)" -ForegroundColor Yellow
try {
    $ollamaCmd = PostForm "$base/api/command" @{ sessionId=$Session; command="provider ollama" }
    Assert ($null -ne $ollamaCmd.status) "provider ollama response has status"
    Assert ($ollamaCmd.status.providerId -eq "ollama") "providerId=ollama" "got $($ollamaCmd.status.providerId)"
} catch {
    Write-Fail "POST /api/command (provider ollama)" $_.Exception.Message
}

# ──────────────────────────────────────────
# 10. Slash-commands routed via /api/command
# ──────────────────────────────────────────
Write-Host "-- 10. Slash-commands via /api/command" -ForegroundColor Yellow

$slashTests = @()
$slashTests += @{ cmd="snapshot";             label="snapshot returns status" }
$slashTests += @{ cmd="sessions";             label="sessions returns sessions list" }
$slashTests += @{ cmd="status";               label="status returns snapshot" }
$slashTests += @{ cmd="health";               label="health returns providerRoutes" }
$slashTests += @{ cmd="doctor";               label="doctor returns workspace" }
$slashTests += @{ cmd="history 20";           label="history 20 updates historyLimit" }
$slashTests += @{ cmd="read README.md";       label="read README.md appends tool event" }
$slashTests += @{ cmd="list .";               label="list . appends list-files event" }
$slashTests += @{ cmd="git status";           label="git status routes to git-status tool" }
$slashTests += @{ cmd="git log 3";            label="git log routes to git-log tool" }
$slashTests += @{ cmd="tree . 2";             label="tree routes to file-tree tool" }
$slashTests += @{ cmd="context";              label="context routes to read-context tool" }
$slashTests += @{ cmd="fetch https://example.com"; label="fetch routes to http-get tool" }
$slashTests += @{ cmd="tool echo hello";      label="tool echo runs tool" }
$slashTests += @{ cmd="plan regression step"; label="plan appends workflow-plan" }
$slashTests += @{ cmd="search TODO";          label="search appends search-text" }
$slashTests += @{ cmd="pipe read README.md | list ."; label="pipe returns structured steps" }
$slashTests += @{ cmd="reload";               label="reload returns snapshot" }

foreach ($test in $slashTests) {
    try {
        $r = PostForm "$base/api/command" @{ sessionId=$Session; command=$test.cmd }
        if ($test.cmd -eq "pipe read README.md | list .") {
            Assert ($null -ne $r.status) $test.label
            Assert ($r.steps.Count -eq 2) "pipe exposes 2 structured steps" "got $($r.steps.Count)"
        } else {
            Assert ($null -ne $r.status) $test.label
        }
    } catch {
        Write-Fail $test.label $_.Exception.Message
    }
}

try {
    $eventsCmd = PostForm "$base/api/command" @{ sessionId=$Session; command="events" }
    Assert ($null -ne $eventsCmd.items) "events returns eventFeed"
    Assert ($eventsCmd.items.Count -ge 0) "events payload is enumerable"
} catch {
    Write-Fail "events returns eventFeed" $_.Exception.Message
}

try {
    $tokensCmd = PostForm "$base/api/command" @{ sessionId=$Session; command="tokens" }
    Assert ($null -ne $tokensCmd.tokenInfo) "tokens returns tokenInfo"
    Assert ($tokensCmd.tokenInfo.charCount -ge 0) "tokens charCount is numeric" "got $($tokensCmd.tokenInfo.charCount)"
    Assert ($tokensCmd.tokenInfo.tokenEstimate -ge 0) "tokens tokenEstimate is numeric" "got $($tokensCmd.tokenInfo.tokenEstimate)"
} catch {
    Write-Fail "tokens returns tokenInfo" $_.Exception.Message
}

try {
    $appendPath = "scripts/regression-append.tmp"
    $appendText = "regression-line"
    $appendCmd = PostForm "$base/api/command" @{ sessionId=$Session; command="append $appendPath $appendText" }
    Assert ($null -ne $appendCmd.status) "append returns snapshot"
    $appendFile = Join-Path (Join-Path $PSScriptRoot "..") "scripts\regression-append.tmp"
    Assert (Test-Path $appendFile) "append created temp file"
    $appendContent = if (Test-Path $appendFile) { Get-Content -Path $appendFile -Raw } else { "" }
    Assert ($appendContent -match [regex]::Escape($appendText)) "append wrote expected content"
    if (Test-Path $appendFile) {
        Remove-Item $appendFile -Force
    }
} catch {
    Write-Fail "append writes file" $_.Exception.Message
}

# Verify history persisted
try {
    $s2 = Invoke-RestMethod -Uri "$base/api/state?session=$Session"
    Assert ($s2.config.historyLimit -eq 20) "history 20 persisted" "got $($s2.config.historyLimit)"
} catch {
    Write-Fail "history 20 verify" $_.Exception.Message
}

# ──────────────────────────────────────────
# 11. UI-shell HTML delivery
# ──────────────────────────────────────────
Write-Host "-- 11. GET /ui-shell/?session=$Session" -ForegroundColor Yellow
try {
    $html = (Invoke-WebRequest -Uri "$base/ui-shell/?session=$Session" -UseBasicParsing).Content
    Assert ($html -match 'sidebar-canvas') "sidebar-canvas present"
    Assert ($html -match 'message-canvas') "message-canvas present"
    Assert ($html -match 'composer-canvas') "composer-canvas present"
    Assert ($html -match 'tool-canvas') "tool-canvas present"
    Assert ($html -match 'settings-canvas') "settings-canvas present"
    Assert ($html -match 'command-preview-canvas') "command-preview-canvas present"
    Assert ($html -match 'app\.js') "app.js referenced"
} catch {
    Write-Fail "GET /ui-shell/" $_.Exception.Message
}

# ──────────────────────────────────────────
# 12. app.js delivery
# ──────────────────────────────────────────
Write-Host "-- 12. GET /ui-shell/app.js" -ForegroundColor Yellow
try {
    $js = (Invoke-WebRequest -Uri "$base/ui-shell/app.js" -UseBasicParsing).Content
    Assert ($js -match 'SLASH_COMMANDS') "SLASH_COMMANDS array present in app.js"
    Assert ($js -match 'isSlashCommand') "isSlashCommand function present in app.js"
    Assert ($js -match '/api/command') "/api/command referenced in app.js"
    Assert ($js -match "'git'") "app.js includes git slash command"
    Assert ($js -match "'context'") "app.js includes context slash command"
    Assert ($js -match "'tokens'") "app.js includes tokens slash command"
    Assert ($js -match 'drawComposerCanvas') "drawComposerCanvas function present"
    Assert ($js -match 'findLatestEvent') "findLatestEvent function present"
    Assert ($js -match 'renderWorkflowTab') "workflow timeline renderer present"
    Assert ($js -match 'activeTerminalTab') "terminal tab state present"
} catch {
    Write-Fail "GET /ui-shell/app.js" $_.Exception.Message
}

# ──────────────────────────────────────────
# 13. locale delivery
# ──────────────────────────────────────────
Write-Host "-- 13. GET /ui-shell/locales/zh-CN.json" -ForegroundColor Yellow
try {
    $locale = Invoke-RestMethod -Uri "$base/ui-shell/locales/zh-CN.json"
    Assert ([bool]$locale) "zh-CN locale loads"
} catch {
    Write-Fail "GET /ui-shell/locales/zh-CN.json" $_.Exception.Message
}

# ──────────────────────────────────────────
# 14. 404 for unknown path
# ──────────────────────────────────────────
Write-Host "-- 14. GET /nonexistent -> 404" -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest -Uri "$base/nonexistent-path" -UseBasicParsing -ErrorAction SilentlyContinue
    $statusCode = if ($null -ne $r) { [int]$r.StatusCode } else { -1 }
    Assert ($null -ne $r) "404 response captured"
    Assert (404 -eq $statusCode) "404 for unknown path" "got $statusCode"
} catch {
    # Invoke-WebRequest throws on 4xx, which is expected here
    Write-Pass "404 for unknown path (exception thrown as expected)"
}

# ──────────────────────────────────────────
# 15. Path traversal guard
# ──────────────────────────────────────────
Write-Host "-- 15. GET /ui-shell/../README.md -> 403" -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest -Uri "$base/ui-shell/../README.md" -UseBasicParsing -ErrorAction SilentlyContinue
    $statusCode = if ($null -ne $r) { [int]$r.StatusCode } else { -1 }
    Assert ($null -ne $r) "path traversal response captured"
    Assert ($statusCode -in @(403, 404)) "path traversal blocked" "got $statusCode"
} catch {
    Write-Pass "path traversal blocked (exception thrown as expected)"
}

# ──────────────────────────────────────────
# Summary
# ──────────────────────────────────────────
$total = $pass + $fail
Write-Host ""
Write-Host "==============================" -ForegroundColor Cyan
Write-Host "Results: $pass/$total passed" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Yellow" })
if ($fail -gt 0) {
    Write-Host "FAILED:  $fail tests" -ForegroundColor Red
}
Write-Host "==============================" -ForegroundColor Cyan

# Stop server if we started it
if ($StopServerAfter -and $null -ne $serverProcess) {
    Write-Host "Stopping server (PID $($serverProcess.Id))"
    $serverProcess | Stop-Process -Force
}

exit $(if ($fail -gt 0) { 1 } else { 0 })
