$ErrorActionPreference='Stop'
$sourceRoot='D:\gpt-workspace\octocode\source'
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRoot 'build-desktop-product.remote.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw $parseErrors[0]}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-BuildDirectory'},$true)
# Extracting a function loses its script location; supply the original literal root.
Invoke-Expression ($function.Extent.Text.Replace('$PSScriptRoot', "'$sourceRoot'"))
$probe=Join-Path $PSScriptRoot ('cleanup-check-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $probe | Out-Null
[IO.File]::WriteAllText((Join-Path $probe 'marker'),'test')
Remove-BuildDirectory $probe
if(Test-Path $probe){throw 'Expected directory to be removed'}
$rejected=$false
try { Remove-BuildDirectory 'D:\gpt-workspace\unrelated-project' } catch { $rejected=$_.Exception.Message -like 'Cleanup escaped*' }
if(!$rejected){throw 'Out-of-scope cleanup was not rejected'}
'Build cleanup scope and normal removal PASS'
