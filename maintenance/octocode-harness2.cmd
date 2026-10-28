@echo off
setlocal
for %%I in ("%~dp0..") do set "OCTOCODE_ROOT=%%~fI"
if not exist "%OCTOCODE_ROOT%\environments\scripts\octocode_harness2.py" (
  echo OctoCode Harness2 was not found in this installation. 1>&2
  exit /b 1
)
"%OCTOCODE_ROOT%\environments\python\python.exe" "%OCTOCODE_ROOT%\environments\scripts\octocode_harness2.py" %*
exit /b %ERRORLEVEL%
