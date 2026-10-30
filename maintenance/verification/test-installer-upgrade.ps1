$ErrorActionPreference = 'Stop'
$desktop = Join-Path $PSScriptRoot '..\..\desktop-shell'
$fixture = Join-Path $env:TEMP ('octocode-upgrade-' + [Guid]::NewGuid().ToString('N'))
$existing = Join-Path $fixture 'existing install''s $workspace'
New-Item -ItemType Directory -Path (Join-Path $existing 'resources\app') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $existing 'Fixture.exe'), 'owned fixture')
[IO.File]::WriteAllText((Join-Path $existing 'resources\app\product.json'), '{}')
$helper = [IO.Path]::GetFullPath((Join-Path $desktop 'build\win32\octocode-upgrade.iss'))
$iss = @'
#define AppId "{{2712EB73-B50F-47BD-A655-FC29326B8B55}"
#define ExeBasename "Fixture"
#define EnvironmentRootKey "HKCU"
#define InstallTarget "user"
[Setup]
AppId={#AppId}
AppName=OctoCode upgrade regression
AppVersion=1.0
DefaultDirName={#FixtureRoot}\fresh
PrivilegesRequired=lowest
SetupMutex={code:GetSetupMutex}
OutputDir={#FixtureRoot}
OutputBaseFilename=FixtureSetup
Uninstallable=no
CreateAppDir=yes
DisableProgramGroupPage=yes
[Code]
#include UpgradeHelper
function GetSetupMutex(Value: String): String;
begin
  Result := 'OctoCodeFixtureSetup{#FixtureId}';
end;
function InitializeSetup(): Boolean;
begin
  if DelegateOctoCodeUpgrade() then begin Result := False; Exit; end;
  Result := True;
end;
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if not WizardSilent() then RaiseException('Expected a silent child');
    SaveStringToFile(ExpandConstant('{app}\upgraded'), 'silent', False);
  end;
end;
'@
$script = Join-Path $fixture 'fixture.iss'
[IO.File]::WriteAllText($script, $iss)
& 'D:\Program Files\develop\Inno Setup 7\ISCC.exe' /Qp "/DFixtureRoot=$fixture" "/DUpgradeHelper=$helper" "/DFixtureId=$([Guid]::NewGuid().ToString('N'))" $script
if ($LASTEXITCODE -ne 0) { throw 'Fixture installer compilation failed' }
$setup = Join-Path $fixture 'FixtureSetup.exe'
$parent = Start-Process -FilePath $setup -ArgumentList @('/SP-',('/DIR="' + $existing + '"'),('/LOG="' + (Join-Path $fixture 'handoff.log') + '"')) -WindowStyle Hidden -PassThru
if (-not $parent.WaitForExit(60000)) { throw "Fixture did not finish; inspect $fixture" }
for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $existing 'upgraded')); $attempt++) { Start-Sleep -Milliseconds 200 }
if ((Get-Content -LiteralPath (Join-Path $existing 'upgraded') -Raw) -ne 'silent') { throw 'Legacy handoff did not run a silent child' }
$fresh = Join-Path $fixture 'fresh install'
$child = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SP-','/NORESTART',('/DIR="' + $fresh + '"')) -WindowStyle Hidden -PassThru
if (-not $child.WaitForExit(30000) -or $child.ExitCode -ne 0) { throw 'Fresh installer failed' }
if ((Get-Content -LiteralPath (Join-Path $fresh 'upgraded') -Raw) -ne 'silent') { throw 'Fresh installation failed' }
Write-Output "PASS: real Inno installer delegates legacy handoff silently and preserves fresh install behavior ($fixture)"
$global:LASTEXITCODE = 0
