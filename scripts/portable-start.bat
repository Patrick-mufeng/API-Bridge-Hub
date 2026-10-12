@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title BridgeHub
cd /d "%~dp0"

echo ============================================
echo   BridgeHub - personal AI API relay hub
echo ============================================

rem ---- bundled runtimes on PATH (portable: no system install needed) ----
set "PATH=%~dp0runtime\node;%~dp0runtime\python;%~dp0runtime\python\Scripts;%PATH%"

rem sanity: runtimes present?
if not exist "runtime\node\node.exe" (
  echo [!] runtime\node\node.exe is missing. The archive may be incomplete.
  pause
  exit /b 1
)

rem ---- config: first run copies the template ----
if not exist "new-api-main\.env" (
  if exist "new-api-main\.env.example" (
    copy /y "new-api-main\.env.example" "new-api-main\.env" >nul
    echo [BridgeHub] created .env from template
  )
)

rem ---- already running? ----
netstat -ano | findstr "LISTENING" | findstr /C:":3000 " >nul
if not errorlevel 1 (
  echo [BridgeHub] port 3000 is already in use - the hub is probably running.
  echo [BridgeHub] open http://localhost:3000 , or stop that process first.
  pause
  exit /b 0
)

echo [BridgeHub] starting hub at http://localhost:3000
echo [BridgeHub] first run: open the page, create your own admin account.
echo [BridgeHub] relay services auto-start; sign in to each service's own
echo             upstream account inside its panel before use.
echo [BridgeHub] stop: close this window or press Ctrl+C
echo.
start "" http://localhost:3000

rem the hub must run from new-api-main (relative data/, database, logs)
pushd "new-api-main"
"..\new-api-dev.exe"
set EXITCODE=%ERRORLEVEL%
popd

echo.
echo [!] the server exited unexpectedly (code %EXITCODE%) - see the error above.
pause
