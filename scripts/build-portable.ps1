# BridgeHub 便携包打包脚本（Windows PowerShell）
#
# 产出：dist-release/BridgeHub-portable-v1.0.0.zip
# 内容：主站（内嵌前端的单个 exe）+ Bun 运行时（插件宿主用）
# 特点：目标机器零安装，解压双击 start.bat 即用
#
# 为什么只有 Bun：各厂商的登录与请求由社区插件在 Bun 里完成，
# 主站不再扮演反代服务的管理者（见 c642dd6）。所以包里不需要
# Node、Python，也不需要任何服务的 manifest。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1
#   可选参数：
#     -SkipRuntimeDownload   已有 runtime/bun/bun.exe 时跳过下载
#     -SkipBuild             跳过编译（用现有产物，快速重打包）
#     -CheckOnly             只校验输入是否齐全，不下载、不编译、不打包
#                            （CI 用它抓住"引用了已删除目录"这类断裂）

param(
  [switch]$SkipRuntimeDownload,
  [switch]$SkipBuild,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot          # 仓库根
$ReleaseDir= Join-Path $Root 'dist-release'
$StageDir  = Join-Path $ReleaseDir 'BridgeHub'
$CacheDir  = Join-Path $ReleaseDir '_cache'
$Version   = 'v1.0.0'

# 便携运行时版本（锁定，保证可复现）。
# 必须与 new-api-main/pkg/pluginhost/bun.go 的 BunVersion 一致或更新：
# 宿主只保证不低于 BunVersion，更旧的 Bun 会拒绝启动插件。
$BunVersion = '1.4.2'
# 与 bun.go 的 bunSums 同一个值：官方 SHASUMS256.txt 里的 sha256。
# 下载后校验，避免镜像或缓存里被替换过的包进分发包。
$BunSha256  = '78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6'
$BunZipName = "bun-windows-x64-baseline.zip"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# -CheckOnly: 打包脚本最容易坏在"引用了某个已删掉的目录"，而这种错只有
# 真正跑一遍才会暴露。CI 用这一档把输入清单核一遍，不联网、不编译。
if ($CheckOnly) {
  Step "校验打包输入（-CheckOnly）"
  $missing = @()
  foreach ($p in @('new-api-main\.env.example', 'new-api-main\web\package.json',
                   'scripts\portable-start.bat', 'scripts\portable-QUICKSTART.md')) {
    if (-not (Test-Path (Join-Path $Root $p))) { $missing += $p }
  }
  if ($missing.Count -gt 0) {
    $missing | ForEach-Object { Write-Host "    ! 缺少: $_" -ForegroundColor Red }
    throw "打包输入不完整（见上）"
  }
  # 脚本里不该再出现已删除的 manifest 目录。匹配串拆开拼，免得这行自己命中自己。
  $text = [System.IO.File]::ReadAllText($PSCommandPath, [System.Text.Encoding]::UTF8)
  $deadDir = 'data' + [char]92 + 'reverse-proxy'
  $deadSeed = 'service' + [char]92 + 'reverse' + '_proxy'
  if ($text.Contains($deadDir) -or $text.Contains($deadSeed)) {
    throw "脚本仍引用已删除的 manifest 目录（$deadDir / $deadSeed）"
  }
  Ok "输入齐全，无已删除目录的引用"
  exit 0
}

# ---------------------------------------------------------------------------
Step "准备目录"
# stage 里上一轮的产物必须清干净，否则会带着旧数据库、旧密钥、旧日志
# 一起打包。逐个目录清：只删文件不会删掉上一轮多出来的目录。
Remove-Item -Recurse -Force (Join-Path $StageDir 'new-api-main') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $StageDir 'runtime') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $StageDir, $CacheDir | Out-Null
Ok "stage: $StageDir"

# ---------------------------------------------------------------------------
Step "准备 Bun 运行时（插件宿主用，$BunVersion）"

$BunZip  = Join-Path $CacheDir $BunZipName
$BunDir  = Join-Path $StageDir 'runtime\bun'
$BunExe  = Join-Path $BunDir 'bun.exe'

if (Test-Path $BunExe) {
  Ok "Bun 运行时已存在（复用）"
} else {
  if (-not (Test-Path $BunZip)) {
    if ($SkipRuntimeDownload) {
      throw "缺少 $BunZip 且已指定 -SkipRuntimeDownload。先联网跑一次，或手动把 Bun 解压到 $BunDir"
    }
    $url = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/$BunZipName"
    Write-Host "    下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $BunZip -UseBasicParsing
  } else { Ok "Bun zip 已缓存" }

  # 校验和：一个被替换过的 bun.exe 会以主站的身份跑所有插件
  $actual = (Get-FileHash -Path $BunZip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $BunSha256) {
    Remove-Item $BunZip -Force -ErrorAction SilentlyContinue
    throw "Bun zip 校验和不符（期望 $BunSha256，实际 $actual），已删除；请重跑或检查网络"
  }
  Ok "Bun zip 校验和通过"

  New-Item -ItemType Directory -Force -Path $BunDir | Out-Null
  Expand-Archive -Path $BunZip -DestinationPath $BunDir -Force
  # zip 里有一层 bun-windows-x64-baseline/ 目录，拍平到 runtime\bun\
  $inner = Get-ChildItem $BunDir -Directory | Select-Object -First 1
  if ($inner) {
    Get-ChildItem $inner.FullName | Move-Item -Destination $BunDir -Force
    Remove-Item -Recurse -Force $inner.FullName
  }
  if (-not (Test-Path $BunExe)) { throw "解包后找不到 $BunExe" }
  Ok "Bun 运行时就绪"
}

# ---------------------------------------------------------------------------
Step "编译主站（前端 + Go，strip 符号）"

if (-not $SkipBuild) {
  Push-Location (Join-Path $Root 'new-api-main')
  try {
    if (-not (Test-Path 'web\dist\index.html')) {
      Push-Location web
      bun install --registry https://registry.npmmirror.com
      bun run build
      Pop-Location
    }
    $env:CGO_ENABLED = '0'
    go build -trimpath -ldflags="-s -w" -o (Join-Path $StageDir 'new-api-dev.exe') .
    if ($LASTEXITCODE -ne 0) { throw "go build 失败" }
    Ok "主站已编译（stripped）"
  } finally {
    Pop-Location
  }
} else {
  $built = Join-Path $Root 'new-api-main\new-api-dev.exe'
  if (-not (Test-Path $built)) { throw "-SkipBuild 需要 $built 已存在" }
  Copy-Item $built $StageDir -Force
  Warn "使用现有主站产物（-SkipBuild）"
}

# 主站配置模板（首次运行由 start.bat 复制为 .env）
# new-api-main 目录在"准备目录"阶段被整体删除，这里必须先建目录。
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir 'new-api-main') | Out-Null
Copy-Item (Join-Path $Root 'new-api-main\.env.example') (Join-Path $StageDir 'new-api-main\.env.example') -Force
Ok "主站配置模板"

# ---------------------------------------------------------------------------
Step "启动脚本与快速上手文档"

# start.bat 在仓库根面向开发（会调用 bun/go 编译）。分发版用专门的入口覆盖。
Copy-Item (Join-Path $PSScriptRoot 'portable-start.bat') (Join-Path $StageDir 'start.bat') -Force
Copy-Item (Join-Path $PSScriptRoot 'portable-QUICKSTART.md') (Join-Path $StageDir 'QUICKSTART.md') -Force
Ok "启动脚本与快速上手文档"

# ---------------------------------------------------------------------------
Step "打包前校验"

# 分发出去的包不该带任何本地状态：数据库、日志、凭据、插件登录态。
$forbidden = @()
$forbidden += Get-ChildItem $StageDir -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '\.(db|db-wal|db-shm|log)$' -or $_.Name -eq 'plugin-auth.json' -or $_.Name -eq '.env' }
if ($forbidden.Count -gt 0) {
  $forbidden | ForEach-Object { Write-Host "    ! 不该进包的文件: $($_.FullName)" -ForegroundColor Red }
  throw "打包内容含本地状态文件（见上）"
}
Ok "无数据库 / 日志 / 凭据"

# 二进制必须能起来：--version 之类的自检不做，但至少确认不是 0 字节
$exe = Get-Item (Join-Path $StageDir 'new-api-dev.exe')
if ($exe.Length -lt 5MB) { throw "new-api-dev.exe 只有 $([math]::Round($exe.Length/1MB,1)) MB，像是编译失败的空壳" }
Ok "主站二进制 $([math]::Round($exe.Length/1MB,1)) MB"

# ---------------------------------------------------------------------------
Step "打包 zip"

$zip = Join-Path $ReleaseDir "BridgeHub-portable-$Version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Ok "产出: $zip ($size MB)"

Write-Host "`n完成。本地验证：解压 zip 到新目录并双击 start.bat" -ForegroundColor Green
