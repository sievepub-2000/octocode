$ErrorActionPreference = 'Stop'
$desktop = Join-Path $PSScriptRoot '..\..\desktop-shell'
$fixture = Join-Path $env:TEMP ('octocode-upgrade-' + [Guid]::NewGuid().ToString('N'))
$existing = Join-Path $fixture 'existing install''s $workspace'
New-Item -ItemType Directory -Path (Join-Path $existing 'resources\app') -Force | Out-Null
$guiSource = Join-Path $fixture 'Fixture.cs'
[IO.File]::WriteAllText($guiSource, @'
using System;
using System.IO;
using System.Windows.Forms;
class Fixture {
  [STAThread] static void Main() {
    var form = new Form { Text = "Owned OctoCode upgrade fixture", ShowInTaskbar = false, WindowState = FormWindowState.Minimized };
    form.Shown += (s, e) => File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "gui-ready"), "yes");
    Application.Run(form);
  }
}
'@)
$newExecutable = Join-Path $fixture 'Fixture-new.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$newExecutable" $guiSource
if ($LASTEXITCODE -ne 0) { throw 'Owned GUI fixture compilation failed' }
Copy-Item -LiteralPath $newExecutable -Destination (Join-Path $existing 'Fixture.exe')
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
CloseApplications=yes
RestartApplications=no
[Files]
Source: "{#FixtureRoot}\Fixture-new.exe"; DestDir: "{app}"; DestName: "Fixture.exe"; Flags: ignoreversion
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
$gui = Start-Process -FilePath (Join-Path $existing 'Fixture.exe') -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $existing 'gui-ready')); $attempt++) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path -LiteralPath (Join-Path $existing 'gui-ready'))) { throw "Owned GUI did not become ready; inspect $fixture" }
$parent = Start-Process -FilePath $setup -ArgumentList @('/SP-',('/DIR="' + $existing + '"'),('/LOG="' + (Join-Path $fixture 'handoff.log') + '"')) -WindowStyle Hidden -PassThru
if (-not $parent.WaitForExit(60000)) { throw "Fixture did not finish; inspect $fixture" }
for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $existing 'upgraded')); $attempt++) { Start-Sleep -Milliseconds 200 }
if ((Get-Content -LiteralPath (Join-Path $existing 'upgraded') -Raw) -ne 'silent') { throw 'Legacy handoff did not run a silent child' }
if (-not $gui.WaitForExit(10000)) { throw "Restart Manager did not close the owned fixture; inspect $fixture" }
$ready = Join-Path $existing 'gui-ready'
Remove-Item -LiteralPath $ready
Remove-Item -LiteralPath (Join-Path $existing 'upgraded')
$gui = Start-Process -FilePath (Join-Path $existing 'Fixture.exe') -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $ready); $attempt++) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path -LiteralPath $ready)) { throw 'Second owned GUI did not become ready' }
$parent = Start-Process -FilePath $setup -ArgumentList @('/SP-','/VERYSILENT','/NOCLOSEAPPLICATIONS',('/DIR="' + $existing + '"')) -WindowStyle Hidden -PassThru
if (-not $parent.WaitForExit(60000)) { throw 'Silent legacy handoff did not finish' }
for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $existing 'upgraded')); $attempt++) { Start-Sleep -Milliseconds 200 }
if (-not $gui.WaitForExit(10000) -or -not (Test-Path -LiteralPath (Join-Path $existing 'upgraded'))) { throw 'Silent legacy no-close flag was not normalized' }
$fresh = Join-Path $fixture 'fresh install'
$child = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SP-','/NORESTART',('/DIR="' + $fresh + '"')) -WindowStyle Hidden -PassThru
if (-not $child.WaitForExit(30000) -or $child.ExitCode -ne 0) { throw 'Fresh installer failed' }
if ((Get-Content -LiteralPath (Join-Path $fresh 'upgraded') -Raw) -ne 'silent') { throw 'Fresh installation failed' }
$abortRoot = Join-Path $fixture 'interrupted install'
New-Item -ItemType Directory -Path (Join-Path $abortRoot 'resources\app\out') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $abortRoot 'resources\app\out\main.js'), 'retained old entry')
[IO.File]::WriteAllText((Join-Path $abortRoot 'resources\app\node_modules.asar'), 'retained old modules')
$production = Get-Content -LiteralPath (Join-Path $desktop 'build\win32\code.iss') -Raw
$deletions = ([regex]::Match($production, '(?s)\[InstallDelete\](.*?)\[UninstallDelete\]').Groups[1].Value -split "`r?`n" | Where-Object { $_ -like '*Name: "{app}*' }) -join "`n"
$abortScript = @'
#define VersionedResourcesFolder ""
[Setup]
AppName=Owned interrupted upgrade fixture
AppVersion=1.0
DefaultDirName={#FixtureRoot}\unused
PrivilegesRequired=lowest
OutputDir={#FixtureRoot}
OutputBaseFilename=AbortFixtureSetup
Uninstallable=no
DisableProgramGroupPage=yes
[InstallDelete]
RUNTIME_DELETIONS
[Files]
Source: "{#FixtureRoot}\Fixture-new.exe"; DestDir: "{app}"; BeforeInstall: FailExtraction
[Code]
function IsNotBackgroundUpdate(): Boolean;
begin Result := True; end;
function GetCurrentProcessId(): Cardinal;
  external 'GetCurrentProcessId@kernel32.dll stdcall';
procedure FailExtraction();
begin
  SaveStringToFile(ExpandConstant('{app}\write-started'), IntToStr(GetCurrentProcessId()), False);
  Sleep(30000);
end;
'@
$abortScript = $abortScript.Replace('RUNTIME_DELETIONS', $deletions)
$abortIss = Join-Path $fixture 'abort.iss'
[IO.File]::WriteAllText($abortIss, $abortScript)
& 'D:\Program Files\develop\Inno Setup 7\ISCC.exe' /Qp "/DFixtureRoot=$fixture" $abortIss
if ($LASTEXITCODE -ne 0) { throw 'Abort fixture compilation failed' }
$failed = Start-Process -FilePath (Join-Path $fixture 'AbortFixtureSetup.exe') -ArgumentList @('/SP-','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $abortRoot + '"')) -WindowStyle Hidden -PassThru
$writeStarted = Join-Path $abortRoot 'write-started'
for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $writeStarted); $attempt++) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path -LiteralPath $writeStarted)) { throw 'Owned fixture did not reach the replacement write' }
$ownedWorkerId = [int]([IO.File]::ReadAllText($writeStarted))
$ownedWorker = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedWorkerId"
if (-not $ownedWorker -or $ownedWorker.ParentProcessId -ne $failed.Id -or [IO.Path]::GetFileName($ownedWorker.ExecutablePath) -ne 'AbortFixtureSetup.tmp' -or -not $ownedWorker.CommandLine.Contains($fixture)) { throw 'Refusing to interrupt an unverified fixture process' }
# Simulate a crash only in this owned temporary installer, before its replacement write.
Stop-Process -Id $ownedWorkerId -Force
if (-not $failed.WaitForExit(30000)) { throw 'Owned interrupted fixture did not exit' }
if (Test-Path -LiteralPath (Join-Path $abortRoot 'Fixture-new.exe')) { throw 'Expected the owned replacement write to be aborted' }
if (-not (Test-Path -LiteralPath (Join-Path $abortRoot 'resources\app\out\main.js')) -or -not (Test-Path -LiteralPath (Join-Path $abortRoot 'resources\app\node_modules.asar'))) { throw 'Interrupted upgrade deleted the existing runtime before replacement' }
Write-Output "PASS: silent legacy handoffs, non-force Restart Manager, fresh install, and old runtime preservation after simulated extraction failure ($fixture)"
$global:LASTEXITCODE = 0
