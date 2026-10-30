function ExistingOctoCodeDirectory(): String;
var
  RegKey: String;
begin
  Result := ExpandConstant('{param:DIR|}');
  if Result = '' then begin
    RegKey := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + copy('{#AppId}', 2, 38) + '_is1';
    if not RegQueryStringValue({#EnvironmentRootKey}, RegKey, 'InstallLocation', Result) then begin
#if "system" == InstallTarget
      Result := 'E:\Program Files\octocode';
#else
      Result := '';
#endif
    end;
  end;
  if not FileExists(AddBackslash(Result) + '{#ExeBasename}.exe') or
     not FileExists(AddBackslash(Result) + 'resources\app\product.json') then
    Result := '';
end;

function NeedsSilentOctoCodeUpgrade(): Boolean;
var
  Index: Integer;
begin
  Result := False;
  if (ExistingOctoCodeDirectory() = '') or (ExpandConstant('{param:update|}') <> '') then Exit;
  Result := not WizardSilent();
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/NOCLOSEAPPLICATIONS') = 0 then Result := True;
end;

function GetCurrentProcessId(): Cardinal;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

function DelegateOctoCodeUpgrade(): Boolean;
var
  ExitCode: Integer;
  Parameters, Command, Installer, Directory: String;
begin
  Result := NeedsSilentOctoCodeUpgrade();
  if not Result then Exit;
  Installer := ExpandConstant('{srcexe}');
  Directory := ExistingOctoCodeDirectory();
  StringChangeEx(Installer, '''', '''''', True);
  StringChangeEx(Directory, '''', '''''', True);
  // Inno locks its payload until exit. A hidden helper waits for this normal
  // exit before reopening the same installer with silent upgrade arguments.
  Command := '$p=Get-Process -Id ' + IntToStr(GetCurrentProcessId()) + ' -ErrorAction SilentlyContinue; ' +
    'if($p -and !$p.WaitForExit(30000)){exit 1}; ' +
    '$s=Start-Process -FilePath ''' + Installer + ''' -WorkingDirectory ''' + Directory + ''' -WindowStyle Hidden ' +
    '-ArgumentList @(''/SP-'',''/VERYSILENT'',''/SUPPRESSMSGBOXES'',''/LOG'',''/NORESTART'',' +
    '''/mergetasks=runcode,!desktopicon,!quicklaunchicon'',(''/DIR='' + [char]34 + ''' + Directory + ''' + [char]34)) -Wait -PassThru; exit $s.ExitCode';
  Parameters := '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command ' + AddQuotes(Command);
  if not ExecAsOriginalUser(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, ExistingOctoCodeDirectory(), SW_HIDE, ewNoWait, ExitCode) then
    RaiseException(Format('Unable to start the OctoCode background upgrade: %d (%s)', [ExitCode, SysErrorMessage(ExitCode)]));
end;
