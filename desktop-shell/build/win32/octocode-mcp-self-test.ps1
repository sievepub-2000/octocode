param(
	[string]$AppRoot = (Split-Path $PSScriptRoot -Parent),
	[string]$SettingsPath
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($AppRoot)
$environmentRoot = Join-Path $root 'environments'
$node = Join-Path $environmentRoot 'node\node.exe'
$smoke = Join-Path $root 'test\mcp-stdio-smoke.mjs'
$workspace = Join-Path $root 'workspace'
if (-not $SettingsPath) {
	$SettingsPath = Join-Path $root 'environments\tools\mcp\mcp_settings.json'
}
$SettingsPath = [IO.Path]::GetFullPath($SettingsPath)

foreach ($requiredFile in $node, $smoke, $settingsPath) {
	if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Required MCP smoke input is missing: $requiredFile" }
}

$env:OCTOCODE_NODE = $node
$env:OCTOCODE_PYTHON_BASE = Join-Path $environmentRoot 'python\python.exe'
$env:OCTOCODE_ENVIRONMENTS = $environmentRoot
$env:OCTOCODE_WORKSPACE = $workspace
$env:OCTOCODE_DATA = Join-Path $root 'data'

function Resolve-McpValue([string]$Value) {
	$resolved = $Value
	foreach ($match in [regex]::Matches($Value, '\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}')) {
		$name = $match.Groups[1].Value
		$environmentValue = [Environment]::GetEnvironmentVariable($name, 'Process')
		if ($null -eq $environmentValue) { throw "MCP setting references undefined environment variable: $name" }
		$resolved = $resolved.Replace($match.Value, $environmentValue)
	}
	$resolved
}

$servers = @(((Get-Content -LiteralPath $settingsPath -Encoding UTF8 -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties))
if (-not $servers) { throw "No MCP servers are configured in $settingsPath" }

foreach ($server in $servers) {
	if ($server.Value.disabled -eq $true -or $server.Value.url -or -not $server.Value.command) {
		throw "MCP server is not an enabled local stdio server: $($server.Name)"
	}
	$command = Resolve-McpValue ([string]$server.Value.command)
	$arguments = @($server.Value.args | ForEach-Object { Resolve-McpValue ([string]$_) })
	if (-not (Test-Path -LiteralPath $command -PathType Leaf)) { throw "MCP command is missing for $($server.Name): $command" }

	$previousEnvironment = @{}
	try {
		foreach ($entry in @($server.Value.env.PSObject.Properties | Where-Object { $null -ne $_ })) {
			$previousEnvironment[$entry.Name] = [Environment]::GetEnvironmentVariable($entry.Name, 'Process')
			[Environment]::SetEnvironmentVariable($entry.Name, (Resolve-McpValue ([string]$entry.Value)), 'Process')
		}
		$output = & $node $smoke $command @arguments 2>&1
		if ($LASTEXITCODE -ne 0) {
			$output | Select-Object -Last 20
			throw "$($server.Name) MCP smoke failed"
		}
	} finally {
		foreach ($entry in $previousEnvironment.GetEnumerator()) {
			[Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
		}
	}
	$responses = @($output | Where-Object { $_ -match '^\s*\{' } | ForEach-Object { $_ | ConvertFrom-Json })
	$toolCount = @($responses | Where-Object id -eq 2 | Select-Object -ExpandProperty result | Select-Object -ExpandProperty tools).Count
	if ($toolCount -lt 1) { throw "$($server.Name) returned no tools" }
	"MCP=$($server.Name)|COMMAND=$command|ARGS=$($arguments -join ' ')|TOOLS=$toolCount|STATUS=PASS"
}
