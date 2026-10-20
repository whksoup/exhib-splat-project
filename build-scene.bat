@echo off
rem Build a scene: scenes\<name>\scene.json -> scenes\<name>\build\ (parts one after another, unchanged parts reused)
rem Usage: build-scene.bat <name> [--force] [--part <id>] [--dry-run] [--keep-temp]
setlocal
if "%~1"=="" (
  echo Usage: build-scene.bat ^<scene-name^> [--force] [--part ^<id^>] [--dry-run] [--keep-temp]
  exit /b 2
)
node "%~dp0pipeline\build-scene.mjs" %*
exit /b %ERRORLEVEL%
