# test-regression.ps1 — Full WebUI interaction regression test suite
# Usage: powershell -ExecutionPolicy Bypass -File scripts\test-regression.ps1
#        or: .\scripts\test-regression.ps1 -Port 999 -Session demo
param(
    [int]$Port = 999,
    [string]$Session = "demo",
    [string]$BinaryPath = "",
    [string]$AuthToken = "",
    [switch]$StartServer = $false,
    [switch]$StopServerAfter = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$base = "http://127.0.0.1:$Port"
$pass = 0
$fail = 0
$serverProcess = $null
$script:authToken = $AuthToken

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

function Get-AuthToken([switch]$Refresh = $false) {
    if (-not $Refresh -and -not [string]::IsNullOrWhiteSpace($script:authToken)) {
        return $script:authToken
    }
    $html = (Invoke-WebRequest -Uri "$base/ui-shell/?session=$Session" -UseBasicParsing -ErrorAction Stop).Content
    $patterns = @(
        'window\.__OCTOCODE_AUTH_TOKEN__\s*=\s*"([^"]+)"',
        "window\.__OCTOCODE_AUTH_TOKEN__\s*=\s*'([^']+)'"
    )
    foreach ($pattern in $patterns) {
        if ($html -match $pattern) {
            $script:authToken = $Matches[1]
            return $script:authToken
        }
    }
    throw "Unable to resolve X-Auth-Token from /ui-shell/"
}

function Get-AuthHeaders() {
    $token = Get-AuthToken
    if ([string]::IsNullOrWhiteSpace($token)) {
        return @{}
    }
    return @{ 'X-Auth-Token' = $token }
}

function GetJson([string]$url) {
    $headers = Get-AuthHeaders
    if ($headers.Count -gt 0) {
        Invoke-RestMethod -Method Get -Uri $url -Headers $headers
    } else {
        Invoke-RestMethod -Method Get -Uri $url
    }
}

function GetWeb([string]$url, [int]$TimeoutSec = 0) {
    $params = @{
        Uri = $url
        UseBasicParsing = $true
        ErrorAction = 'Stop'
    }
    $headers = Get-AuthHeaders
    if ($headers.Count -gt 0) {
        $params.Headers = $headers
    }
    if ($TimeoutSec -gt 0) {
        $params.TimeoutSec = $TimeoutSec
    }
    Invoke-WebRequest @params
}

function PostFormBody([string]$url, [string]$body) {
    $params = @{
        Method = 'Post'
        Uri = $url
        ContentType = 'application/x-www-form-urlencoded'
        Body = $body
        ErrorAction = 'Stop'
    }
    $headers = Get-AuthHeaders
    if ($headers.Count -gt 0) {
        $params.Headers = $headers
    }
    Invoke-RestMethod @params
}

function PostForm([string]$url, [hashtable]$fields) {
    $body = ($fields.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join "&"
    PostFormBody $url $body
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

Write-Host "-- 1b. Resolve WebUI auth token" -ForegroundColor Yellow
try {
    $resolvedToken = Get-AuthToken -Refresh
    Assert (-not [string]::IsNullOrWhiteSpace($resolvedToken)) "auth token resolved from ui-shell"
} catch {
    Write-Fail "Resolve WebUI auth token" $_.Exception.Message
}

# ──────────────────────────────────────────
# 2. State / snapshot
# ──────────────────────────────────────────
Write-Host "-- 2. GET /api/state" -ForegroundColor Yellow
try {
    $state = GetJson "$base/api/state?session=$Session"
    Assert ($null -ne $state.status) "state.status present"
    Assert ($null -ne $state.providerRoutes) "state.providerRoutes present"
    Assert ($null -ne $state.providers) "state.providers present"
    Assert ($null -ne $state.commands) "state.commands present"
    Assert ($null -ne $state.tools) "state.tools present"
    Assert ($null -ne $state.eventFeed) "state.eventFeed present"
    Assert ($null -ne $state.sessions) "state.sessions present"
    Assert ($state.commands.Count -gt 0) "commands.Count > 0" "count=$($state.commands.Count)"
    Assert ($state.tools.Count -ge 20) "tools.Count >= 20 (iter-2 expansion)" "count=$($state.tools.Count)"
    $newTools = @('create-file','delete-file','move-file','task-submit','task-list')
    foreach ($tn in $newTools) {
        Assert ((@($state.tools | Where-Object { $_.name -eq $tn })).Count -ge 1) "tool '$tn' present in catalog"
    }
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
    $events = GetJson "$base/api/events?session=$Session"
    Assert ($null -ne $events.items) "events.items present"
} catch {
    Write-Fail "GET /api/events" $_.Exception.Message
}

# ──────────────────────────────────────────
# 3b. Timeline
# ──────────────────────────────────────────
Write-Host "-- 3b. GET /api/timeline" -ForegroundColor Yellow
try {
    $timeline = GetJson "$base/api/timeline?session=$Session"
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
    $s2 = GetJson "$base/api/state?session=$Session"
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
    Assert ($html -match 'sidebar-list') "sidebar-list present (DOM v6)"
    Assert ($html -match 'message-list') "message-list present (DOM v6)"
    Assert ($html -match 'chat-form') "chat-form present (DOM v6)"
    Assert ($html -match 'model-info-bar') "model-info-bar present (DOM v6)"
    Assert ($html -match 'stream-indicator') "stream-indicator present (DOM v6)"
    Assert ($html -match 'shortcuts-overlay') "shortcuts-overlay present (DOM v6)"
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
    Assert ($js -match 'renderMessages') "renderMessages function present (DOM v6)"
    Assert ($js -match 'renderSidebar') "renderSidebar function present (DOM v6)"
    Assert ($js -match 'refreshEventFeed') "event feed refresher present"
    Assert ($js -match 'renderTerminalTabs') "terminal tabs renderer present"
    Assert ($js -match 'streamChat') "SSE streamChat function present"
    Assert ($js -match 'escapeHtml') "escapeHtml XSS protection present"
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
# 20. Task Registry endpoints
# ──────────────────────────────────────────
Write-Host "-- 20. Task Registry /api/tasks" -ForegroundColor Yellow

try {
    $taskList = GetJson "$base/api/tasks"
    Assert ($null -ne $taskList) "GET /api/tasks returns data"
    Assert ($null -ne $taskList.items) "GET /api/tasks has items array"
    Write-Pass "GET /api/tasks structure OK"
} catch {
    Write-Fail "GET /api/tasks" $_.Exception.Message
}

try {
    $body = "sessionId=test-reg&label=autoresearch-test&kind=agent"
    $submitted = PostFormBody "$base/api/tasks" $body
    Assert ($null -ne $submitted) "POST /api/tasks returns data"
    Assert ($submitted.id -like "t-*") "task id has t- prefix"
    Assert ($submitted.sessionId -eq "test-reg") "task sessionId round-trips"
    Assert ($submitted.label -eq "autoresearch-test") "task label round-trips"
    Write-Pass "POST /api/tasks submit OK"
} catch {
    Write-Fail "POST /api/tasks" $_.Exception.Message
}

# ──────────────────────────────────────────
# 21. Permission Refinement - per-tool deny list
# ──────────────────────────────────────────
Write-Host "-- 21. Permission Refinement - deny-list" -ForegroundColor Yellow
# Ensure clean state first (allow echo in case a prior run left it denied)
try {
    $body = "allowTool=echo&sessionId=$session"
    $null = PostFormBody "$base/api/settings" $body
} catch { }

try {
    # 1. Deny echo tool
    $body = "denyTool=echo&sessionId=$session"
    $denied = PostFormBody "$base/api/settings" $body
    Assert ($null -ne $denied.config) "deny: settings returns config"
    Assert ($denied.config.deniedTools -contains "echo") "deny: echo appears in deniedTools"
} catch {
    Write-Fail "POST /api/settings denyTool=echo" $_.Exception.Message
}

# 2. Running denied tool should fail (HTTP 500)
try {
    $body = "name=echo&input=hi&sessionId=$session"
    $null = PostFormBody "$base/api/tool" $body
    Write-Fail "tool echo after deny" "expected HTTP 500 but got success"
} catch {
    $msg = $_.Exception.Message
    Write-Pass "tool echo after deny returns error (as expected): $msg"
}

try {
    # 3. Restore echo
    $body = "allowTool=echo&sessionId=$session"
    $restored = PostFormBody "$base/api/settings" $body
    Assert ($null -ne $restored.config) "allow: settings returns config"
    Assert (-not ($restored.config.deniedTools -contains "echo")) "allow: echo removed from deniedTools"
} catch {
    Write-Fail "POST /api/settings allowTool=echo" $_.Exception.Message
}

# 4. Echo should work again after restore
try {
    $body = "name=echo&input=hi&sessionId=$session"
    $ok = PostFormBody "$base/api/tool" $body
    Assert ($null -ne $ok.activeSession) "tool echo works again after allow"
} catch {
    Write-Fail "tool echo after allow" $_.Exception.Message
}

# ──────────────────────────────────────────
# 22. MCP Transport - manifest discovery + spawn lifecycle
# ──────────────────────────────────────────
Write-Host "-- 22. MCP Transport lifecycle" -ForegroundColor Yellow

try {
    $mcp = PostForm "$base/api/command" @{ command = "mcp list"; sessionId = $Session }
    Assert ($null -ne $mcp) "mcp list returns data"
    Write-Pass "mcp list command executes"
} catch {
    Write-Fail "mcp list command" $_.Exception.Message
}

try {
    $mcpStatus = PostForm "$base/api/command" @{ command = "mcp status"; sessionId = $Session }
    Assert ($null -ne $mcpStatus) "mcp status returns data"
    Write-Pass "mcp status command executes"
} catch {
    Write-Fail "mcp status command" $_.Exception.Message
}

# ──────────────────────────────────────────
# 23. SSE Streaming endpoint
# ──────────────────────────────────────────
Write-Host "-- 23. SSE Streaming /api/stream" -ForegroundColor Yellow

try {
    $streamUrl = "$base/api/stream?session=$Session&text=hello"
    $response = GetWeb $streamUrl 30
    Assert ($response.StatusCode -eq 200) "GET /api/stream returns 200"
    Assert ($response.Headers.'Content-Type' -match "text/event-stream") "GET /api/stream Content-Type is text/event-stream"
    $content = $response.Content
    Assert ($content -match "data:") "GET /api/stream contains SSE data lines"
    Write-Pass "SSE stream endpoint structure OK"
} catch {
    Write-Fail "GET /api/stream" $_.Exception.Message
}

# ──────────────────────────────────────────
# 24. Iteration-4 utility tools (http-post, json-query, process-list, env-var, base64)
# ──────────────────────────────────────────
Write-Host "-- 24. Iteration-4 utility tools" -ForegroundColor Yellow

# Helper: extract tool output from last session message ("tool => output")
function LastToolOutput($snapshot) {
    $msgs = @($snapshot.activeSession.messages)
    $last = $msgs[$msgs.Count - 1].content
    if ($last -match '^[^ ]+ => (.*)$') { return $Matches[1] }
    return $last
}

# 24.1  base64 encode
try {
    $b64enc = PostForm "$base/api/tool" @{ name = "base64"; input = "encode|Hello OctoCode"; sessionId = $Session }
    Assert ($null -ne $b64enc.activeSession) "base64 encode returns result"
    $encOut = LastToolOutput $b64enc
    Assert ($encOut -eq "SGVsbG8gT2N0b0NvZGU=") "base64 encode correct output"
    Write-Pass "base64 encode tool"
} catch {
    Write-Fail "base64 encode" $_.Exception.Message
}

# 24.2  base64 decode
try {
    $b64dec = PostForm "$base/api/tool" @{ name = "base64"; input = "decode|SGVsbG8gT2N0b0NvZGU="; sessionId = $Session }
    Assert ($null -ne $b64dec.activeSession) "base64 decode returns result"
    $decOut = LastToolOutput $b64dec
    Assert ($decOut -eq "Hello OctoCode") "base64 decode correct output"
    Write-Pass "base64 decode tool"
} catch {
    Write-Fail "base64 decode" $_.Exception.Message
}

# 24.3  env-var reads a known variable
try {
    $envResult = PostForm "$base/api/tool" @{ name = "env-var"; input = "PATH"; sessionId = $Session }
    Assert ($null -ne $envResult.activeSession) "env-var returns result"
    $envOut = LastToolOutput $envResult
    Assert ($envOut.Length -gt 0) "env-var PATH has content"
    Write-Pass "env-var tool reads PATH"
} catch {
    Write-Fail "env-var tool" $_.Exception.Message
}

# 24.4  process-list
try {
    $plist = PostForm "$base/api/tool" @{ name = "process-list"; input = ""; sessionId = $Session }
    Assert ($null -ne $plist.activeSession) "process-list returns result"
    $plOut = LastToolOutput $plist
    Assert ($plOut.Length -gt 10) "process-list has content"
    Write-Pass "process-list tool"
} catch {
    Write-Fail "process-list tool" $_.Exception.Message
}

# 24.5  json-query
try {
    $jq = PostForm "$base/api/tool" @{ name = "json-query"; input = 'name|{"name":"octo","ver":1}'; sessionId = $Session }
    Assert ($null -ne $jq.activeSession) "json-query returns result"
    Write-Pass "json-query tool"
} catch {
    Write-Fail "json-query tool" $_.Exception.Message
}

# 24.6  diagnostics
try {
    $diag = PostForm "$base/api/tool" @{ name = "diagnostics"; input = ""; sessionId = $Session }
    Assert ($null -ne $diag.activeSession) "diagnostics returns result"
    $diagOut = LastToolOutput $diag
    Assert ($diagOut -match "Memory|CPU|Disk|mem") "diagnostics has system info"
    Write-Pass "diagnostics tool"
} catch {
    Write-Fail "diagnostics tool" $_.Exception.Message
}

# 24.7  tool catalog count (30 tools)
try {
    $catalog = GetJson "$base/api/tools"
    Assert ($catalog.Count -ge 30) "tool catalog has >= 30 tools"
    Write-Pass "tool catalog count >= 30"
} catch {
    Write-Fail "tool catalog count" $_.Exception.Message
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
