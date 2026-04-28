#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Idempotently clone/refresh the third_party/ drop-points OctoCode
    references for design, benchmarking, and security review.

.DESCRIPTION
    This script performs the minimum Git operations needed to make the
    subdirectories under third_party/ consumable as read-only reference
    trees. It never runs any of the fetched code.

    Sources:
      * third_party/naive-ui — Vue 3 component library, design reference
        for WebUI panels.
      * third_party/pentagi  — multi-agent offensive framework, code-
        review reference ONLY. The script refuses to fetch pentagi
        unless the operator passes -AllowOffensive, because it is
        offensive tooling and must not be silently vendored.

.PARAMETER AllowOffensive
    Required to fetch third_party/pentagi. Without it, the pentagi
    drop-point is skipped with a warning.

.EXAMPLE
    pwsh scripts/fetch-integrations.ps1
    pwsh scripts/fetch-integrations.ps1 -AllowOffensive
#>
[CmdletBinding()]
param(
    [switch]$AllowOffensive
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$thirdParty = Join-Path $repoRoot 'third_party'

if (-not (Test-Path $thirdParty)) {
    throw "third_party/ not found at $thirdParty — are you inside the OctoCode checkout?"
}

# Pinned integrations. Each entry: name, url, ref (tag or commit).
$targets = @(
    @{ name='naive-ui'; url='https://github.com/tusen-ai/naive-ui.git'; ref='v2.38.2'; offensive=$false },
    @{ name='pentagi';  url='https://github.com/vxcontrol/pentagi.git'; ref='main';   offensive=$true  }
)

foreach ($t in $targets) {
    $dir = Join-Path $thirdParty $t.name
    if (-not (Test-Path $dir)) {
        Write-Warning "skipping $($t.name): drop-point directory missing ($dir)"
        continue
    }
    if ($t.offensive -and -not $AllowOffensive) {
        Write-Warning "skipping $($t.name): offensive tooling, re-run with -AllowOffensive to fetch"
        continue
    }
    $srcDir = Join-Path $dir 'src'
    if (Test-Path (Join-Path $srcDir '.git')) {
        Write-Host "refreshing $($t.name) @ $($t.ref)"
        & git -C $srcDir fetch --depth=1 origin $t.ref
        if ($LASTEXITCODE -ne 0) { throw "git fetch failed for $($t.name)" }
        & git -C $srcDir checkout --detach FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { throw "git checkout failed for $($t.name)" }
    }
    else {
        Write-Host "cloning $($t.name) @ $($t.ref)"
        & git clone --depth=1 --branch $t.ref $t.url $srcDir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed for $($t.name)" }
    }
    Write-Host "$($t.name) ready at $srcDir"
}

Write-Host "`nDone. Nothing under third_party/*/src/ is compiled or executed by OctoCode." -ForegroundColor Green
