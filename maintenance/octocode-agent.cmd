@echo off
setlocal
set "OCTOCODE_HARNESS=%~dp0octocode-harness.exe"
set "OCTOCODE_INSTALL="
if exist "%~dp0..\OctoCode.exe" for %%I in ("%~dp0..") do set "OCTOCODE_INSTALL=%%~fI"
if exist "%~dp0..\..\..\..\..\OctoCode.exe" for %%I in ("%~dp0..\..\..\..\..") do set "OCTOCODE_INSTALL=%%~fI"
if defined OCTOCODE_INSTALL (
  set "OCTOCODE_ENVIRONMENTS=%OCTOCODE_INSTALL%\environments"
  set "OCTOCODE_DATA=%OCTOCODE_INSTALL%\data"
  set "OCTOCODE_NODE=%OCTOCODE_INSTALL%\environments\node\node.exe"
  set "OCTOCODE_PYTHON_BASE=%OCTOCODE_INSTALL%\environments\python\python.exe"
)
if not exist "%OCTOCODE_HARNESS%" (
  echo OctoCode CLI harness was not found. 1>&2
  exit /b 1
)
"%OCTOCODE_HARNESS%" %*
exit /b %ERRORLEVEL%
