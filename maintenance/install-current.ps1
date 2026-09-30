param([ValidateSet('Snapshot','Uninstall','Install','Upgrade')][string]$Step)
$ErrorActionPreference='Stop'
$project='D:\gpt-workspace\octocode'
$install='D:\Program Files\OctoCode'
$shellPackage=Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop-shell\package.json'
$releaseVersion=(Get-Content -LiteralPath $shellPackage -Raw -Encoding UTF8 | ConvertFrom-Json).version
if($releaseVersion -notmatch '^\d+\.\d+\.\d+$'){throw "Invalid desktop version: $releaseVersion"}
$audit=Join-Path $project ('verification\release-'+$releaseVersion)
New-Item -ItemType Directory -Path $audit -Force | Out-Null
$baseline=Join-Path $audit 'preserved-current.json'
if(Get-Process OctoCode,octocode-host,octocode-harness -ErrorAction SilentlyContinue){throw 'Close OctoCode normally before installation maintenance'}
if($Step -eq 'Snapshot'){
    $snapshot=Get-Content (Join-Path $project 'backups\current-config\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $files=@($snapshot.files | ForEach-Object {if ($_.source) {$_.source} else {Join-Path ($project+'\runtime\data\user-data') $_.path}})
    $files+=@('AGENTS.md','pelican-bicycle.html') | ForEach-Object {Join-Path ($project+'\runtime\workspace') $_}
	$files=@($files | ForEach-Object {
		if(Test-Path -LiteralPath $_){$_}
		elseif($_ -like '*\settings\mcp_settings.json') {Join-Path $project 'runtime\environments\tools\mcp\mcp_settings.json'}
		elseif($_ -like '*\settings\mcp_settings.json.bak-20260921') {Join-Path $project 'audit\legacy-mcp-before-initialize-20260923.json'}
		else {throw "User file missing before snapshot: $_"}
	} | Select-Object -Unique)
    @($files | ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_).Hash}}) | ConvertTo-Json | Set-Content -Encoding UTF8 $baseline
    'Current user configuration and artifacts recorded'
    exit
}
if(!(Test-Path -LiteralPath $baseline)){throw 'Current preservation baseline is missing'}
if($Step -eq 'Install'){
    if(Test-Path -LiteralPath $install){throw 'Clean installation requires an absent installation directory'}
    New-Item -ItemType Directory -Path $install | Out-Null
    foreach($name in @('data','workspace','environments')){
        $target=[IO.Path]::GetFullPath((Join-Path ($project+'\runtime') $name))
        if(!$target.StartsWith($project+'\runtime\',[StringComparison]::OrdinalIgnoreCase)){throw 'Runtime path escaped project'}
        if(!(Test-Path -LiteralPath $target)){New-Item -ItemType Directory -Path $target | Out-Null}
        if((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime target must be physical'}
        New-Item -ItemType Junction -Path (Join-Path $install $name) -Target $target | Out-Null
    }
}
$uninstall=$Step -eq 'Uninstall'
$exe=if($uninstall){Join-Path $install 'unins000.exe'}else{Join-Path $project 'releases\OctoCodeSetup-latest.exe'}
if(!$uninstall){
    $manifest=Get-Content (Join-Path $project 'releases\release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if((Get-FileHash -LiteralPath $exe).Hash -ne $manifest.installer.sha256){throw 'Installer differs from current release manifest'}
}
$log=Join-Path $audit ('native-'+$Step+'-'+(Get-Date -Format yyyyMMddHHmmss)+'.log')
$arguments='/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="'+$log+'"'
if(!$uninstall){$arguments+=' /DIR="'+$install+'" /TASKS="desktopicon,addtopath,associatewithfiles"'}
$process=Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if($process.ExitCode){throw "Native $Step failed: $($process.ExitCode)"}
if(!$uninstall -and (Select-String -LiteralPath $log -Pattern 'initialize\.ps1 failed with exit code' -Quiet)){
    throw "Native $Step completed with an initialization failure; inspect $log"
}
$registry=@()
foreach($hive in @('HKLM:','HKCU:')){
    foreach($name in @('Software\Microsoft\Windows\CurrentVersion\Uninstall\{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}_is1','Software\Microsoft\Windows\CurrentVersion\App Paths\OctoCode.exe','Software\Classes\Applications\OctoCode.exe')){
        if(Test-Path ($hive+'\'+$name)){$registry+=($hive+'\'+$name)}
    }
    $registry+=@(Get-ChildItem ($hive+'\Software\Classes') -ErrorAction SilentlyContinue | Where-Object PSChildName -like 'OctoCode*' | ForEach-Object Name)
}
$desktop=Test-Path 'C:\Users\Public\Desktop\OctoCode.lnk'
$startMenu=Test-Path 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\OctoCode'
$pathEntries=@(@('Machine','User') | ForEach-Object {[Environment]::GetEnvironmentVariable('Path',$_) -split ';'} | Where-Object {$_.Trim('"').TrimEnd('\') -ieq ($install+'\bin')})
if($uninstall){
    if((Test-Path -LiteralPath $install) -or $registry.Count -or $desktop -or $startMenu -or $pathEntries.Count){throw 'Uninstall left installation directory or system registration'}
}else{
    foreach($name in @('OctoCode.exe','unins000.exe','unins000.dat')){if(!(Test-Path -LiteralPath (Join-Path $install $name))){throw "Missing installed file: $name"}}
    foreach($name in @('data','workspace','environments')){
        $entry=Get-Item -LiteralPath (Join-Path $install $name) -Force
        if($entry.LinkType -ne 'Junction' -or $entry.Target[0] -ine ($project+'\runtime\'+$name)){throw "Incorrect runtime junction: $name"}
    }
    if(!$desktop -or !$startMenu -or !$registry.Count){throw 'Standard installation registration incomplete'}
}
foreach($item in (Get-Content $baseline -Raw -Encoding UTF8 | ConvertFrom-Json)){
    if(Test-Path -LiteralPath $item.path){
        if((Get-FileHash -LiteralPath $item.path).Hash -ne $item.sha256){throw "Current user file changed: $($item.path)"}
        continue
    }
    if($item.path -like '*\settings\mcp_settings.json'){
        $backup=Join-Path $project 'audit\legacy-mcp-before-initialize-20260923.json'
        $global=Join-Path $project 'runtime\environments\tools\mcp\mcp_settings.json'
        if((Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $global) -and
            (Get-FileHash -LiteralPath $backup).Hash -eq $item.sha256){
            $old=(Get-Content -LiteralPath $backup -Raw -Encoding UTF8 | ConvertFrom-Json).mcpServers
            $new=(Get-Content -LiteralPath $global -Raw -Encoding UTF8 | ConvertFrom-Json).mcpServers
            $missing=@($old.PSObject.Properties.Name | Where-Object { $_ -notin $new.PSObject.Properties.Name })
            if(!$missing.Count){continue}
        }
    }
    throw "Current user file changed or missing: $($item.path)"
}
$result=@{step=$Step;checkedAt=(Get-Date).ToString('o');exitCode=$process.ExitCode;programRootExists=(Test-Path $install);desktop=$desktop;startMenu=$startMenu;registryEntries=$registry.Count;pathEntries=$pathEntries.Count;preservation='PASS'}
$result | ConvertTo-Json | Set-Content -Encoding UTF8 ($log+'.json')
$result | ConvertTo-Json -Compress
