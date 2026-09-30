function Assert-CleanBuildLog {
	param(
		[Parameter(Mandatory)][string]$Log,
		[string[]]$Allowlist = @('(?i)^\s+Compressing:', '(?i)^\s*(?:Finished with\s+)?0 warnings?\s*$')
	)

	$issuePattern = '(?i)(?:\b(?:npm\s+)?warn(?:ing)?s?\b|\bfallback\s*:|\busing fallback\b|\bfalling back\b|\bfell back\b)'
	$issues = @(Select-String -LiteralPath $Log -Pattern $issuePattern | Where-Object {
		$line = $_.Line
		-not @($Allowlist | Where-Object { $line -match $_ }).Count
	})
	if ($issues) {
		$issues | Select-Object -First 20 | ForEach-Object { "BUILD_LOG_ISSUE=$($_.LineNumber):$($_.Line)" }
		throw "Build log contains $($issues.Count) non-allowlisted warning/fallback entries: $Log"
	}
}
