param(
 [ValidateSet('Snapshot','Uninstall','Install','Upgrade')][string]$Step='Upgrade',
 [string]$ProjectRoot='D:\gpt-workspace\octocode',
 [string]$InstallRoot='E:\Program Files\octocode',
 [switch]$VerifyOnly
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$install=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$runtime=if($install -ieq 'E:\Program Files\octocode'){$install}else{Join-Path $project 'runtime'}
$baseline=Join-Path $project 'verification\upgrade-preservation\preserved-current.json'
function Normalize-Target($Target) {
 $value=[string]@($Target)[0]
 if(!$value){throw 'Runtime junction has no target'}
 [IO.Path]::GetFullPath($value.Replace('\\?\','')).TrimEnd('\')
}
function Assert-Stopped {
 $owned=@(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase))
 })
 if($owned.Count){throw 'Close the installed desktop and owned tasks normally before upgrade maintenance'}
}
function Runtime-Roots {
 $roots=[ordered]@{}
 foreach($name in @('data','workspace','environments')){
  $target=Join-Path $runtime $name
  $entry=Get-Item -LiteralPath (Join-Path $install $name) -Force
  if($runtime -ieq $install){
   if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Formal E installation requires physical storage: $name"}
  }elseif($entry.LinkType -ne 'Junction' -or (Normalize-Target $entry.Target) -ine $target){throw "Incorrect authoritative runtime junction: $name"}
  if((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime target must be physical'}
  $roots[$name]=$target
 }
 $roots
}
function Record-Tree([string]$directory,[string]$scope) {
 foreach($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)){
  $key=$scope+'/'+$entry.Name
  if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){
   [pscustomobject][ordered]@{key=$key;kind='link';value=(@($entry.Target)-join '|')}
  }elseif($entry.PSIsContainer){
   [pscustomobject][ordered]@{key=$key;kind='directory';value=$null}
   Record-Tree $entry.FullName $key
  }elseif($entry.Name -notmatch '(\.runtime-lock(?:-journal)?|\.db-shm|\.vscdb-shm)$'){
   [pscustomobject][ordered]@{key=$key;kind='file';value=(Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash}
  }
 }
}
function Current-Preservation {
 $roots=Runtime-Roots; $data=Join-Path $roots.data 'user-data'; $files=@()
 foreach($relative in @('Local State','Preferences','Secure Preferences')){
  $path=Join-Path $data $relative
  $files += [pscustomobject][ordered]@{key='user-data/'+$relative;kind='optional-file';value=$(if(Test-Path -LiteralPath $path -PathType Leaf){(Get-FileHash -LiteralPath $path).Hash}else{$null})}
 }
 foreach($relative in @('User','profiles')){
  $path=Join-Path $data $relative
  $files += [pscustomobject][ordered]@{key='user-data/'+$relative;kind='optional-directory';value=(Test-Path -LiteralPath $path -PathType Container)}
  if(Test-Path -LiteralPath $path -PathType Container){$files+=@(Record-Tree $path ('user-data/'+$relative))}
 }
 $shared=Join-Path $roots.data 'shared-data'
 $files += [pscustomobject][ordered]@{key='shared-data';kind='optional-directory';value=(Test-Path -LiteralPath $shared -PathType Container)}
 if(Test-Path -LiteralPath $shared -PathType Container){$files+=@(Record-Tree $shared 'shared-data')}
 $files+=@(Record-Tree $roots.workspace 'workspace')
 $tools=Join-Path $roots.environments 'tools'
 foreach($relative in @('skills','hooks')){
  $path=Join-Path $tools $relative
  if(Test-Path -LiteralPath $path -PathType Container){$files+=@(Record-Tree $path ('system-tools/'+$relative))}
 }
 $mcp=Join-Path $tools 'mcp\mcp_settings.json'
 $files += [pscustomobject][ordered]@{key='system-tools/mcp/mcp_settings.json';kind='optional-file';value=$(if(Test-Path -LiteralPath $mcp -PathType Leaf){(Get-FileHash -LiteralPath $mcp).Hash}else{$null})}
 [pscustomobject][ordered]@{schemaVersion=3;install=$install;runtime=$runtime;files=@($files | Sort-Object key)}
}
function Assert-Preservation($expected) {
 if($expected.schemaVersion -ne 3 -or $expected.install -ine $install -or $expected.runtime -ine $runtime){throw 'Preservation baseline belongs to another layout or obsolete schema'}
 if($expected.files -isnot [array] -or !$expected.files.Count){throw 'Preservation baseline requires a nonempty files array'}
 $required=@{
  'user-data/Local State'='optional-file';'user-data/Preferences'='optional-file';'user-data/Secure Preferences'='optional-file'
  'user-data/User'='optional-directory';'user-data/profiles'='optional-directory';'system-tools/mcp/mcp_settings.json'='optional-file'
  'shared-data'='optional-directory'
 }
 $keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($file in $expected.files){
  if($file -isnot [pscustomobject] -or @('key','kind','value' | Where-Object {$_ -notin $file.PSObject.Properties.Name}).Count){throw 'Preservation baseline record requires key, kind and value'}
  if($file.key -isnot [string] -or [string]::IsNullOrWhiteSpace($file.key) -or $file.kind -isnot [string] -or !$keys.Add($file.key)){throw 'Preservation baseline record identity is invalid or duplicated'}
  if($required.ContainsKey($file.key)){
   if($file.kind -cne $required[$file.key]){throw 'Preservation baseline optional record kind is invalid'}
  }elseif($file.key -notmatch '\A(?:user-data/(?:User|profiles)|shared-data|workspace|system-tools/(?:skills|hooks))/.+\z' -or $file.kind -notin @('file','directory','link')){throw 'Preservation baseline record identity is outside recorded roots'}
  if($file.key.Contains('\') -or @($file.key.Split('/') | Where-Object {$_ -in @('','.','..')}).Count){throw 'Preservation baseline record key is not canonical'}
  switch($file.kind){
   'file' {if($file.value -isnot [string] -or $file.value -notmatch '\A[a-fA-F0-9]{64}\z'){throw 'Preservation baseline file record requires SHA256'}}
   'optional-file' {if($null -ne $file.value -and ($file.value -isnot [string] -or $file.value -notmatch '\A[a-fA-F0-9]{64}\z')){throw 'Preservation baseline optional file record requires SHA256 or null'}}
   'optional-directory' {if($file.value -isnot [bool]){throw 'Preservation baseline optional directory record requires a boolean'}}
   'directory' {if($null -ne $file.value){throw 'Preservation baseline directory record requires null'}}
   'link' {if($file.value -isnot [string]){throw 'Preservation baseline link record requires a string target'}}
  }
 }
 foreach($key in $required.Keys){if(!$keys.Contains($key)){throw 'Preservation baseline is missing a required optional record'}}
 $actual=Current-Preservation; $lookup=@{}
 foreach($file in $actual.files){$lookup[$file.key]=$file}
 foreach($file in $expected.files){
  if(!$lookup.ContainsKey($file.key) -or $lookup[$file.key].kind -ne $file.kind -or $lookup[$file.key].value -cne $file.value){throw "Preserved user state changed or missing: $($file.key)"}
 }
}
function Save-Baseline {
 $snapshot=Current-Preservation; $directory=Split-Path $baseline -Parent
 New-Item -ItemType Directory -Path $directory -Force | Out-Null
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 & icacls.exe $directory /inheritance:r /grant:r ("*"+$sid+":(OI)(CI)F") '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
 if($LASTEXITCODE){throw 'Unable to protect private preservation evidence'}
 if(Test-Path -LiteralPath $baseline){Copy-Item -LiteralPath $baseline -Destination ($baseline+'.previous-'+[guid]::NewGuid().ToString('N'))}
 $snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $baseline -Encoding UTF8
}
Assert-Stopped
if($Step -eq 'Snapshot'){Save-Baseline; 'Current authoritative user state recorded'; return}
if($VerifyOnly){Assert-Preservation (Get-Content -LiteralPath $baseline -Raw -Encoding UTF8 | ConvertFrom-Json); 'Preservation passed (installer not invoked)'; return}
if($Step -eq 'Upgrade' -and !(Test-Path -LiteralPath (Join-Path $install 'OctoCode.exe') -PathType Leaf)){throw 'Upgrade requires an existing installation; never uninstall/reinstall for code updates'}
if($Step -eq 'Install'){throw 'Clean Install is retired from code-update maintenance; use the documented installer manually for a new installation'}
$uninstall=$Step -eq 'Uninstall'
if($uninstall){
 if(!(Test-Path -LiteralPath $baseline)){throw 'Manual uninstall requires an explicit current snapshot'}
 Assert-Preservation (Get-Content -LiteralPath $baseline -Raw -Encoding UTF8 | ConvertFrom-Json)
 $exe=Join-Path $install 'unins000.exe';$version='manual-uninstall'
}else{
 $manifest=Get-Content -LiteralPath (Join-Path $project 'releases\release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 $version=[string]$manifest.shellVersion
 if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Release manifest shellVersion is invalid'}
 $file=[string]$manifest.installer.file
 if(!$file -or [IO.Path]::GetFileName($file) -cne $file){throw 'Manifest installer must be a filename inside releases'}
 $exe=Join-Path $project ('releases\'+$file);$artifact=Get-Item -LiteralPath $exe
 if($manifest.installer.sha256 -notmatch '^[0-9A-Fa-f]{64}$' -or (Get-FileHash -LiteralPath $exe).Hash -ine $manifest.installer.sha256 -or $artifact.Length -ne $manifest.installer.bytes -or $artifact.VersionInfo.ProductVersion.Trim() -ne $version){throw 'Installer hash/size/version differs from promoted release manifest'}
 Save-Baseline
}
$audit=Join-Path $project ('verification\release-'+$version)
New-Item -ItemType Directory -Path $audit -Force | Out-Null
$log=Join-Path $audit ('native-'+$Step+'-'+[guid]::NewGuid().ToString('N')+'.log')
$arguments='/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /LOG="'+$log+'"'
if(!$uninstall){$arguments+=' /DIR="'+$install+'"'} # Preserve prior task selection, no forced associations/PATH/shortcut or auto-launch.
$process=Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if($process.ExitCode){throw "Native $Step failed: $($process.ExitCode); snapshot retained"}
if(!$uninstall){
 foreach($name in @('OctoCode.exe','unins000.exe','unins000.dat')){if(!(Test-Path -LiteralPath (Join-Path $install $name))){throw "Missing upgraded file: $name"}}
 $installedVersion=(Get-Item -LiteralPath (Join-Path $install 'OctoCode.exe')).VersionInfo.ProductVersion.Trim()
 if($installedVersion -ne $version){throw 'Installed executable version differs from promoted shellVersion'}
 if(Select-String -LiteralPath $log -Pattern 'initialize\.ps1 failed with exit code' -Quiet){throw 'Installed initializer failed'}
 Assert-Preservation (Get-Content -LiteralPath $baseline -Raw -Encoding UTF8 | ConvertFrom-Json)
}else{if(Test-Path -LiteralPath (Join-Path $install 'OctoCode.exe')){throw 'Manual uninstall left executable'}}
$result=@{step=$Step;checkedAt=(Get-Date).ToString('o');exitCode=$process.ExitCode;baseline=$baseline;preservation=$(if($uninstall){'manual uninstall: retained state not independently reverified'}else{'PASS'});shellVersion=$(if($uninstall){$null}else{$version});installerSha256=$(if($uninstall){$null}else{$manifest.installer.sha256})}
$result | ConvertTo-Json | Set-Content -LiteralPath ($log+'.json') -Encoding UTF8
$result | ConvertTo-Json -Compress
