#!/usr/bin/env bash
# BridgeHub 启动脚本（Git Bash / Linux 通用）
# 用法：./start.sh   —— 前台运行主站，Ctrl+C 停止
set -e
cd "$(dirname "$0")/new-api-main"

if [ ! -f "web/dist/index.html" ]; then
  echo "[BridgeHub] 未检测到前端构建产物 web/dist"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[!] 未安装 bun，请先安装：https://bun.sh"
    exit 1
  fi
  echo "[BridgeHub] 自动构建前端（首次约 1-2 分钟）..."
  (cd web && bun install --registry https://registry.npmmirror.com && bun run build)
fi

if [ ! -f "new-api-dev.exe" ] && [ ! -f "new-api-dev" ]; then
  echo "[BridgeHub] 编译主站..."
  go build -o new-api-dev .
fi

BIN=./new-api-dev
[ -f "./new-api-dev" ] || BIN=./new-api-dev.exe

if netstat -ano 2>/dev/null | grep LISTENING | grep -q ":3000 "; then
  echo "[BridgeHub] port 3000 already in use - the hub is probably running."
  echo "[BridgeHub] open http://localhost:3000 , or stop that process first."
  exit 0
fi

echo "[BridgeHub] starting hub at http://localhost:3000"
echo "[BridgeHub] enabled relay services auto-start from their manifests"
"$BIN" || echo "[!] the server exited unexpectedly - see the error above"
read -rp "Press Enter to close..." _
