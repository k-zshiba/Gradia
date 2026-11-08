@echo off
setlocal
set "STUDY_APP=%~dp0src-tauri\target\release\study-tool.exe"
if not exist "%STUDY_APP%" (
  echo Study Tool has not been built yet. See README.md.
  pause
  exit /b 1
)
start "" "%STUDY_APP%"
