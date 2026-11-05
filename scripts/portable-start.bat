@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title BridgeHub
cd /d "%~dp0"

echo ============================================
echo   BridgeHub - personal AI API relay hub
echo ============================================

rem ---- bundled Bun for the plugin host (no system install needed) ----
set "MAGPIE_BUN=%~dp0runtime\bun\bun.exe"
if not exist "%MAGPIE_BUN%" (
  echo [!] runtime\bun\bun.exe is missing. The archive may be incomplete.
  echo     Plugins cannot start without it; re-download the package.
  pause
  exit /b 1
)

rem Plugin host state must sit beside the database, not beside the launcher:
rem the server resolves its data folder from the exe, which is this folder,
rem while the database lives in new-api-main\. Point both at the same place
rem so one backup of new-api-main covers accounts, plugins and usage.
set "PLUGIN_HOST_CONFIG_DIR=%~dp0new-api-main\data\plugin-host"
set "PLUGIN_HOST_CACHE_DIR=%~dp0new-api-main\data\plugin-host\cache"

rem ---- config: first run copies the template ----
if not exist "new-api-main\.env" (
  if exist "new-api-main\.env.example" (
    copy /y "new-api-main\.env.example" "new-api-main\.env" >nul
    echo [BridgeHub] created .env from template
  )
)

rem ---- already running? ----
netstat -ano | findstr "LISTENING" | findstr /C:":4501 " >nul
if not errorlevel 1 (
  echo [BridgeHub] port 4501 is already in use - the hub is probably running.
  echo [BridgeHub] open http://localhost:4501 , or stop that process first.
  pause
  exit /b 0
)

echo [BridgeHub] starting hub at http://localhost:4501
echo [BridgeHub] first run: open the page, create your own admin account.
echo [BridgeHub] then: Plugins page -^> install a provider plugin -^> sign in
echo             -^> register it as a channel.
echo [BridgeHub] stop: close this window or press Ctrl+C
echo.
start "" http://localhost:4501

rem the hub must run from new-api-main (relative database, logs)
pushd "new-api-main"
"..\new-api-dev.exe"
set EXITCODE=%ERRORLEVEL%
popd

echo.
echo [!] the server exited unexpectedly (code %EXITCODE%) - see the error above.
pause
