@echo off
setlocal
set "STUDY_APP=%~dp0src-tauri\target\release\gradia.exe"
if not exist "%STUDY_APP%" (
  echo Gradia has not been built yet. See README.md.
  pause
  exit /b 1
)
start "" "%STUDY_APP%"
