$ErrorActionPreference='Stop'
Start-Process -FilePath D:\gpt-workspace\octocode\releases\OctoCodeSetup-latest.exe -ArgumentList '/LANG=english','/NORESTART','/LOG=D:\gpt-workspace\octocode\verification\release-20260921\installer-ui.log' -WindowStyle Hidden
Start-Sleep -Seconds 3
& D:\gpt-workspace\octocode\source\desktop-shell\.build\environments\python\python.exe D:\gpt-workspace\octocode\source\maintenance\verification\installer-ui.py
