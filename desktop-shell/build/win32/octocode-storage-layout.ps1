param(
 [Parameter(Mandatory=$true)][string]$AppRoot,
 [string]$StorageRoot='D:\gpt-workspace\octocode\runtime'
)
$ErrorActionPreference='Stop'
$AppRoot=[IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
$StorageRoot=[IO.Path]::GetFullPath($StorageRoot).TrimEnd('\')
if($AppRoot -eq [IO.Path]::GetPathRoot($AppRoot).TrimEnd('\') -or $StorageRoot -eq [IO.Path]::GetPathRoot($StorageRoot).TrimEnd('\')){throw 'Drive roots are not application/storage directories'}
if($AppRoot.Equals($StorageRoot,[StringComparison]::OrdinalIgnoreCase) -or $AppRoot.StartsWith($StorageRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $StorageRoot.StartsWith($AppRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Application and storage roots must be disjoint'}
New-Item -ItemType Directory -Path $AppRoot,$StorageRoot -Force | Out-Null
foreach($name in @('data','workspace','environments')) {
 $link=Join-Path $AppRoot $name
 $target=Join-Path $StorageRoot $name
 New-Item -ItemType Directory -Path $target -Force | Out-Null
 if(Test-Path -LiteralPath $link) {
  $item=Get-Item -LiteralPath $link -Force
  if(!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Refusing to replace existing physical directory: $link"}
  $actual=([string]@($item.Target)[0]).Replace('\\?\','').TrimEnd('\')
  if(!$actual.Equals($target,[StringComparison]::OrdinalIgnoreCase)){throw "Unexpected junction target: $link"}
 } else {
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
 }
}
