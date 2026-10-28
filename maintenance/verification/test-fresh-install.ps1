param([string]$ProjectRoot='D:\gpt-workspace\octocode',[switch]$ExternalLaunch)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer acceptance in an elevated PowerShell to preserve machine registration'}
$source=Join-Path $ProjectRoot 'source'
$release=Join-Path $ProjectRoot 'releases\v2.0.1-final-welcome'
$installer=Join-Path $release 'OctoCodeSetup.exe'
$formal='E:\Program Files\octocode'
$fixture=Join-Path 'E:\OctoCode-Acceptance' ('fresh-2.0.1-'+[guid]::NewGuid().ToString('N'))
$audit=Join-Path 'E:\OctoCode-Acceptance' ('audit-'+[guid]::NewGuid().ToString('N'))
$node=Join-Path $source 'desktop-shell\.build\environments\node\node.exe'
if((Test-Path 'E:\OctoCode-Acceptance') -and ((Get-Item 'E:\OctoCode-Acceptance' -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Acceptance root must be a physical directory'}
if(!(Test-Path $installer) -or (Test-Path $fixture)){throw 'Invalid fresh installer fixture'}
$verify='const fs=require("fs"),crypto=require("crypto"),path=require("path"),assert=require("assert/strict");const raw=fs.readFileSync(path.join(process.argv[1],"octocode-release.json")),sig=fs.readFileSync(path.join(process.argv[1],"octocode-release.json.sig")),anchor=JSON.parse(fs.readFileSync(process.argv[2]));const key=crypto.createPublicKey({key:Buffer.from(anchor.publicKeySpkiBase64,"base64"),format:"der",type:"spki"});assert(crypto.verify(null,raw,key,sig),"Invalid release signature");const m=JSON.parse(raw);assert.equal(m.version,"2.0.1");console.log(JSON.stringify(m.assets["windows-x64-system"]));'
$asset=(& $node -e $verify $release (Join-Path $source 'maintenance\release-signing\release-public-key.json')) | ConvertFrom-Json
if($LASTEXITCODE -or $asset.name -cne 'OctoCodeSetup.exe' -or (Get-Item $installer).Length -ne $asset.size -or (Get-FileHash $installer).Hash -ine $asset.sha256){throw 'Fresh installer signature/hash/size mismatch'}
if(@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($formal+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Close formal installation normally before fresh acceptance'}
New-Item -ItemType Directory -Path $audit | Out-Null
$keys=@(
 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}_is1',
 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OctoCode.exe',
 'HKLM\SOFTWARE\Classes\OctoCodeSourceFile',
 'HKLM\SOFTWARE\Classes\Applications\OctoCode.exe',
 'HKLM\SOFTWARE\Classes\directory\shell\OctoCode',
 'HKLM\SOFTWARE\Classes\directory\background\shell\OctoCode',
 'HKLM\SOFTWARE\Classes\Drive\shell\OctoCode'
)
$saved=@();$installed=$false;$accepted=$false
for($i=0;$i -lt $keys.Count;$i++){
 $key=$keys[$i];$file=Join-Path $audit ('registry-'+$i+'.reg')
 & reg.exe query $key *> $null;$present=$LASTEXITCODE -eq 0
 if($present){& reg.exe export $key $file /y *> $null;if($LASTEXITCODE){throw "Cannot back up $key"}}
 $saved+=@{key=$key;file=$file;present=$present}
}
$environmentKey=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment',$true)
$pathBefore=$environmentKey.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$pathKind=$environmentKey.GetValueKind('Path')
try{
 $arguments='/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /NOICONS /TASKS="" /DIR="'+$fixture+'" /LOG="'+(Join-Path $audit 'install.log')+'"'
 $p=Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
 if($p.ExitCode){throw "Fresh installer exit $($p.ExitCode)"};$installed=$true
 if(!(Test-Path (Join-Path $fixture 'OctoCode.exe'))){throw 'Fresh executable missing'}
 foreach($boot in 1,2){
  $report=Join-Path $audit ('boot-'+$boot+'.json')
  if($ExternalLaunch){
   @{appRoot=$fixture;report=$report;boot=$boot} | ConvertTo-Json | Set-Content (Join-Path $audit ('launch-request-'+$boot+'.json'))
   $end=(Get-Date).AddSeconds(240)
   while(!(Test-Path -LiteralPath $report) -and (Get-Date) -lt $end){Start-Sleep -Seconds 1}
   if(!(Test-Path -LiteralPath $report)){throw "Standard-user boot $boot timed out"}
   $bootResult=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
   if($bootResult.status -ne 'PASS' -or $bootResult.elevatedWindow){throw "Standard-user boot $boot failed"}
  }else{
   Start-Process -FilePath (Join-Path $fixture 'OctoCode.exe') -ArgumentList '--remote-debugging-port=9337','--remote-debugging-address=127.0.0.1' -WorkingDirectory $fixture | Out-Null
   & $node (Join-Path $PSScriptRoot 'fresh-start-ui.cjs') $fixture $report
   if($LASTEXITCODE){throw "Fresh boot $boot failed"}
  }
  $end=(Get-Date).AddSeconds(60)
  do{$owned=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)});if(!$owned.Count){break};Start-Sleep -Seconds 2}while((Get-Date) -lt $end)
  if($owned.Count){throw 'Fresh application did not quit normally'}
 }
 & (Join-Path $fixture 'test\self-test.ps1') -AppRoot $fixture *> (Join-Path $audit 'self-test.log')
 if($LASTEXITCODE){throw 'Fresh installed self-test failed'}
 $startupErrors=@(Get-ChildItem -LiteralPath (Join-Path $fixture 'data\user-data\logs') -Recurse -File -Filter '*.log' | Select-String -Pattern '\[error\]')
 if($startupErrors.Count){throw "Fresh startup logs contain $($startupErrors.Count) errors; see retained startup-logs"}
 $accepted=$true
}finally{
 $logs=Join-Path $fixture 'data\user-data\logs'
 if(Test-Path -LiteralPath $logs){Copy-Item -LiteralPath $logs -Destination (Join-Path $audit 'startup-logs') -Recurse}
 if($installed -and $accepted){
  $owned=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($fixture+'\',[StringComparison]::OrdinalIgnoreCase)})
  if($owned.Count){$owned | ForEach-Object {Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue};Start-Sleep -Seconds 2}
  $p=Start-Process -FilePath (Join-Path $fixture 'unins000.exe') -ArgumentList ('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="'+(Join-Path $audit 'uninstall.log')+'"') -WindowStyle Hidden -Wait -PassThru
  if($p.ExitCode){Write-Warning 'Fresh uninstall failed; restoring formal registration'}
 }
 foreach($item in $saved){if($item.present){& reg.exe import $item.file *> $null;if($LASTEXITCODE){throw "Cannot restore $($item.key)"}}}
 if($environmentKey.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $pathBefore){$environmentKey.SetValue('Path',$pathBefore,$pathKind)}
 $environmentKey.Dispose()
}
if(Test-Path (Join-Path $fixture 'OctoCode.exe')){throw 'Fresh executable remains after uninstall'}
$restored=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}_is1'
if($restored.InstallLocation.TrimEnd('\') -ine $formal){throw 'Formal install registration was not restored'}
@{status='PASS';fixture=$fixture;audit=$audit;nativeInstall=$true;coldStarts=2;standardUserColdStarts=[bool]$ExternalLaunch;nativeUninstall=$true;formalRegistrationRestored=$true} | ConvertTo-Json | Tee-Object -FilePath (Join-Path $audit 'result.json')
