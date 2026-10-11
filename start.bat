@echo off
setlocal
title BridgeHub
cd /d "%~dp0new-api-main"

echo ============================================
echo   BridgeHub - personal AI API relay hub
echo ============================================

rem ---- frontend build check (missing after a fresh clone) ----
if not exist "web\dist\index.html" (
  echo [BridgeHub] web\dist not found - frontend needs a build.
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [!] bun not found. Install it from https://bun.sh and rerun.
    pause
    exit /b 1
  )
  echo [BridgeHub] building frontend, first run takes 1-2 minutes ...
  pushd web
  call bun install --registry https://registry.npmmirror.com
  call bun run build
  popd
  if not exist "web\dist\index.html" (
    echo [!] frontend build failed. Check the output above.
    pause
    exit /b 1
  )
)

rem ---- server binary check ----
if not exist "new-api-dev.exe" (
  echo [BridgeHub] building server ...
  go build -o new-api-dev.exe .
  if errorlevel 1 (
    echo [!] server build failed. Make sure Go is installed.
    pause
    exit /b 1
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
echo [BridgeHub] enabled relay services auto-start from their manifests.
echo [BridgeHub] stop: close this window or press Ctrl+C
echo.
start "" http://localhost:3000
new-api-dev.exe
echo.
echo [!] the server exited unexpectedly - see the error above.
echo     common causes: port conflict, missing .env, corrupted build.
pause
