@echo off
chcp 65001 >nul
title BridgeHub
cd /d "%~dp0new-api-main"

echo ============================================
echo   BridgeHub - 个人 AI API 中转枢纽
echo ============================================

rem ---- 前端构建产物检查（全新 clone 时缺失）----
if not exist "web\dist\index.html" (
  echo [BridgeHub] 未检测到前端构建产物 web\dist
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [!] 未安装 bun，请先安装：https://bun.sh
    echo     或手动构建前端后重新运行本脚本
    pause
    exit /b 1
  )
  echo [BridgeHub] 自动构建前端（首次约 1-2 分钟）...
  pushd web
  call bun install --registry https://registry.npmmirror.com
  call bun run build
  popd
  if not exist "web\dist\index.html" (
    echo [!] 前端构建失败，请检查上方输出
    pause
    exit /b 1
  )
)

rem ---- 主站二进制检查 ----
if not exist "new-api-dev.exe" (
  echo [BridgeHub] 编译主站...
  go build -o new-api-dev.exe .
  if errorlevel 1 (
    echo [!] 编译失败，请确认已安装 Go 并检查上方输出
    pause
    exit /b 1
  )
)

echo [BridgeHub] 启动主站 http://localhost:3000
echo [BridgeHub] 已启用的反代服务将按 manifest 自动拉起（详见主站日志与「反代服务」面板）
echo [BridgeHub] 停止服务：关闭本窗口或按 Ctrl+C
echo.
start "" http://localhost:3000
new-api-dev.exe
