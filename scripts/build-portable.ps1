# BridgeHub 便携包打包脚本（Windows PowerShell）
#
# 产出：dist-release/BridgeHub-portable-v1.0.0.zip
# 内容：主站（内嵌前端的单个 exe）+ 5 个反代服务（预编译）+ 便携 Node/Python 运行时
# 特点：目标机器零安装，解压双击 start.bat 即用
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1
#   可选参数：
#     -SkipRuntimeDownload   已有 runtime/ 缓存时跳过下载
#     -SkipBuild             跳过编译（用现有产物，快速重打包）

param(
  [switch]$SkipRuntimeDownload,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot          # 仓库根
$ReleaseDir= Join-Path $Root 'dist-release'
$StageDir  = Join-Path $ReleaseDir 'BridgeHub'
$CacheDir  = Join-Path $ReleaseDir '_cache'
$Version   = 'v1.0.0'

# 便携运行时版本（锁定，保证可复现）
# Node 必须 >= 22.18：opencodez 直接用 node 跑 TypeScript 源码，依赖该版本的
# 类型剥离能力；cline 的 .js 里写 ESM 也要求 v22 的模块识别。
$NodeVersion   = 'v22.18.0'
$PythonVersion = '3.11.9'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
Step "准备目录"
# stage 里上一轮的 data 目录（含旧 manifest、日志、数据库）必须清掉，
# 否则会带着上一轮的 qoder.json 等残留一起打包
Remove-Item -Recurse -Force (Join-Path $StageDir 'new-api-main\data') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $StageDir 'new-api-main\one-api.db*') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $StageDir 'new-api-main\.env') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $StageDir, $CacheDir | Out-Null
Ok "stage: $StageDir"

# ---------------------------------------------------------------------------
Step "下载便携运行时（Node $NodeVersion / Python $PythonVersion embeddable）"

$NodeZip   = Join-Path $CacheDir "node-$NodeVersion-win-x64.zip"
$PythonZip = Join-Path $CacheDir "python-$PythonVersion-embed-amd64.zip"

if (-not (Test-Path $NodeZip)) {
  if ($SkipRuntimeDownload) { Warn "缺少 $NodeZip（-SkipRuntimeDownload），将复用现有 runtime" }
  else {
    $url = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
    Write-Host "    下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $NodeZip -UseBasicParsing
  }
} else { Ok "Node zip 已缓存" }

if (-not (Test-Path $PythonZip)) {
  if ($SkipRuntimeDownload) { Warn "缺少 $PythonZip，将复用现有 runtime" }
  else {
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    Write-Host "    下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $PythonZip -UseBasicParsing
  }
} else { Ok "Python zip 已缓存" }

# 解包到 stage/runtime/（已存在则复用）
$RuntimeDir = Join-Path $StageDir 'runtime'
if (Test-Path $NodeZip) {
  $nodeDir = Join-Path $RuntimeDir 'node'
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    Remove-Item -Recurse -Force $nodeDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    Expand-Archive -Path $NodeZip -DestinationPath $nodeDir -Force
    # zip 里有一层目录，拍平
    $inner = Get-ChildItem $nodeDir | Select-Object -First 1
    if ($inner.PSIsContainer) {
      Get-ChildItem $inner.FullName | Move-Item -Destination $nodeDir -Force
      Remove-Item -Recurse -Force $inner.FullName
    }
    Ok "node 运行时就绪"
  } else { Ok "node 运行时已存在" }
}

# ---------------------------------------------------------------------------
Step "编译主站（前端 + Go，strip 符号）"

if (-not $SkipBuild) {
  Push-Location (Join-Path $Root 'new-api-main')
  if (-not (Test-Path 'web/dist/index.html')) {
    Push-Location web
    bun install --registry https://registry.npmmirror.com
    bun run build
    Pop-Location
  }
  $env:CGO_ENABLED = '0'
  go build -trimpath -ldflags="-s -w" -o (Join-Path $StageDir 'new-api-dev.exe') .
  Pop-Location
  Ok "主站已编译（stripped）"
} else {
  Copy-Item (Join-Path $Root 'new-api-main\new-api-dev.exe') $StageDir -Force
  Warn "使用现有主站产物（-SkipBuild）"
}

# 主站配置模板（首次运行由 start.bat 复制为 .env）
Copy-Item (Join-Path $Root 'new-api-main\.env.example') (Join-Path $StageDir 'new-api-main\.env.example') -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $Root 'new-api-main\web\dist')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $StageDir 'new-api-main\web') | Out-Null
  # dist 已嵌入 exe，无需随包分发（省体积）
}
Ok "主站配置模板"

# ---------------------------------------------------------------------------
Step "复制反代服务（5 个，排除无 LICENSE 的 Qoder）"

$services = @('workbuddy-free-main', 'cline-free-main', 'cmdgo-bridge-main', 'opencodez-free-main', 'trae-free-master')

foreach ($svc in $services) {
  $src = Join-Path $Root $svc
  $dst = Join-Path $StageDir $svc
  if (-not (Test-Path $src)) { Warn "跳过缺失的服务: $svc"; continue }

  robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP `
    /XD node_modules .git data auths logs __pycache__ .venv venv `
    /XF '*.db' '*.db-wal' '*.db-shm' '.env' '.env.local' 'config.json' 'state.json' '*.log' | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败: $svc ($LASTEXITCODE)" }
  Ok "复制 $svc"
}

# 预编译产物（已在上一步随目录复制，但 build/ 产物可能被 XD 排除，这里补齐）
# workbuddy: wb2api.exe 随目录复制（*.exe 不在排除名单）
# cmdgo: dist/ 随目录复制
# qoder 排除；cline/opencodez 无需构建

# qoder worker 的 node_modules 需要单独打包吗？——Qoder 整个排除，无需处理。

# opencodez 需要 models.dev.json 吗？首次启动自动拉取。

# ---------------------------------------------------------------------------
Step "准备 Python 运行时（trae 用）"

$pyDir = Join-Path $RuntimeDir 'python'
if (Test-Path $PythonZip) {
  if (-not (Test-Path (Join-Path $pyDir 'python.exe'))) {
    Remove-Item -Recurse -Force $pyDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
    Expand-Archive -Path $PythonZip -DestinationPath $pyDir -Force
    # embeddable 包默认禁用 site-packages，需要打开 import site
    $pth = Join-Path $pyDir 'python311._pth'
    if (Test-Path $pth) {
      (Get-Content $pth) -replace '^#\s*import site$', 'import site' | Set-Content $pth
    }
    Ok "python 运行时就绪"
  } else { Ok "python 运行时已存在" }

  # 安装 trae 依赖到便携 Python。embeddable 包不带 pip，需先引导。
  $req = Join-Path $StageDir 'trae-free-master\requirements.txt'
  if (Test-Path $req) {
    $py = Join-Path $pyDir 'python.exe'
    if (-not (Test-Path (Join-Path $pyDir 'Lib\site-packages\uvicorn'))) {
      # 1) 确保 pip 可用（embeddable 包不自带；用目录存在性判断，避免把
      #    python 的 stderr 当 PowerShell 致命错误）
      $pipDir = Join-Path $pyDir 'Lib\site-packages\pip'
      if (-not (Test-Path $pipDir)) {
        $getPip = Join-Path $CacheDir 'get-pip.py'
        if (-not (Test-Path $getPip)) {
          if ($SkipRuntimeDownload) { throw "缺少 get-pip.py（-SkipRuntimeDownload），无法引导 pip" }
          Write-Host "    引导 pip（get-pip.py）"
          Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
        }
        & $py $getPip --no-warn-script-location
        if ($LASTEXITCODE -ne 0) { throw "pip 引导失败" }
      }
      Ok "pip 可用"

      # 2) 安装依赖（用 cmd 包装避免 python 的 stderr 触发 PowerShell 错误）
      Write-Host "    安装 trae 依赖（uvicorn/fastapi/httpx/cryptography…）"
      & cmd /c "`"$py`" -m pip install --quiet --disable-pip-version-check -i https://pypi.tuna.tsinghua.edu.cn/simple -r `"$req`" 2>&1"
      if ($LASTEXITCODE -ne 0) { throw "trae 依赖安装失败" }

      # 3) 校验关键包可导入，防止"装了个寂寞"
      & cmd /c "`"$py`" -c `"import uvicorn, fastapi, httpx, cryptography`" 2>&1"
      if ($LASTEXITCODE -ne 0) { throw "trae 依赖校验失败（import 不通）" }
      Ok "trae 依赖安装并校验通过"
    } else { Ok "trae 依赖已安装" }
  }
} else { Warn "缺 Python zip，跳过 Python 运行时" }

# ---------------------------------------------------------------------------
Step "复制 data 骨架与 manifest（路径改为包内相对写法）"

$dataSrc = Join-Path $Root 'new-api-main\data\reverse-proxy\services'
$dataDst = Join-Path $StageDir 'new-api-main\data\reverse-proxy\services'
New-Item -ItemType Directory -Force -Path $dataDst | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir 'new-api-main\data\reverse-proxy\logs') | Out-Null

# 包内私有数据目录（密钥/账号/状态），随包走、不依赖系统用户目录
$varRoot = Join-Path $StageDir 'var'
New-Item -ItemType Directory -Force -Path `
  (Join-Path $varRoot 'cmdgo'), `
  (Join-Path $varRoot 'opencodez'), `
  (Join-Path $varRoot 'qoder') | Out-Null

# workbuddy 只认配置文件里的 listen（无 CLI 覆盖），而它的默认值是 :7863，
# 与 manifest 声明的端口不一致，会让"自动启动"误判失败。分发时显式写一份
# 与 manifest 对齐的 config.json（api_key 留空，首次运行不会自己生成，
# 因此这里给一个占位；workbuddy 只在 api_key 非空时校验，空值会自行处理）。
$wbCfgPath = Join-Path $StageDir 'workbuddy-free-main\config.json'
if (-not (Test-Path $wbCfgPath)) {
  $wbExample = Join-Path $StageDir 'workbuddy-free-main\config.example.json'
  if (Test-Path $wbExample) {
    $wb = [System.IO.File]::ReadAllText($wbExample, [System.Text.Encoding]::UTF8)
  } else {
    $wb = '{ "api_key": "" }'
  }
  try {
    $wbObj = ConvertFrom-Json -InputObject $wb
    $wbObj.listen = ':7873'
    # 生成随机 api_key：绝不能把模板占位值（test_key）或开发者密钥打进分发包，
    # 否则所有下载者共用同一个网关密钥。
    $rand = New-Object byte[] 18
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rand)
    $wbObj.api_key = 'sk-' + [Convert]::ToBase64String($rand).Replace('+','').Replace('/','').Replace('=','').Substring(0,24)
    $wbOut = ConvertTo-Json -InputObject $wbObj -Depth 12
    [System.IO.File]::WriteAllText($wbCfgPath, $wbOut, (New-Object System.Text.UTF8Encoding $false))
    Ok "workbuddy 配置已对齐（listen :7873，随机 api_key）"
  } catch {
    Warn "无法生成 workbuddy config.json: $($_.Exception.Message)"
  }
}

foreach ($f in Get-ChildItem $dataSrc -Filter *.json) {
  if ($f.Name -eq 'qoder.json') { continue }  # 未随包分发
  # 必须显式按 UTF-8 读取：Get-Content -Raw 在中文 Windows 上默认用 GBK，
  # 会把 manifest 里的中文描述读成乱码并截断，导致 JSON 非法。
  $json = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)

  switch ($f.Name) {
    'cline.json' {
      # local-server.js 无 package.json 且含 ESM 语法，Node 只在 .mjs 下稳定识别；
      # 官方入口就是 start.mjs（跨平台启动器，会自建 .env.local）。
      $json = $json -replace '"local-server\.js"', '"start.mjs"'
    }
    'trae.json' {
      # trae 首次启动就要求认证源；分发时给一份 .env 模板，让用户在面板里补 token
      Copy-Item (Join-Path $StageDir 'trae-free-master\.env.example') `
                (Join-Path $StageDir 'trae-free-master\.env') -Force -ErrorAction SilentlyContinue
    }
    'cmdgo.json' {
      # 数据目录搬到包内 var/，并用 --data-dir 显式指定（默认是 ~/.cmdgo-bridge）
      $json = $json -replace '"args":\s*\[\s*"dist/index\.js",\s*"--port",\s*"11445"\s*\]',
                          '"args": ["dist/index.js", "--port", "11445", "--data-dir", "../../var/cmdgo"]'
      $json = $json -replace '"path":\s*"[^"]*\.cmdgo-bridge\\\\config\.json"',
                          '"path": "../../var/cmdgo/config.json"'
    }
    'opencodez.json' {
      # OPENCODEZ_CONFIG 指向包内配置文件，密钥文件随其解析
      $json = $json -replace '"path":\s*"[^"]*\.opencodez-free\\\\agent-key\.txt"',
                          '"path": "../../var/opencodez/agent-key.txt"'
      # 注入环境变量，让服务把配置目录认到包内
      if ($json -notmatch '"env"') {
        $json = $json -replace '"key_source"',
                            '"env": { "OPENCODEZ_CONFIG": "../../var/opencodez/config.json" }, "key_source"'
      }
    }
  }

  # 无 BOM 写入。注意：不要对 JSON 文本做换行符替换（会把字符串内的
  # 字面量改成真实换行，直接破坏 JSON）。源文件本身是合法 JSON 即可。
  [System.IO.File]::WriteAllText((Join-Path $dataDst $f.Name), $json, (New-Object System.Text.UTF8Encoding $false))
  Ok "manifest: $($f.Name)"
}

# 生成密钥占位文件：存在但为空，服务/主站首次运行时会自行写入或提示登录
$cmdgoCfg = Join-Path $varRoot 'cmdgo\config.json'
if (-not (Test-Path $cmdgoCfg)) {
  [System.IO.File]::WriteAllText($cmdgoCfg, '{ "apiKey": "" }', (New-Object System.Text.UTF8Encoding $false))
}

# 校验：无 BOM、无绝对路径、且每份都能被 JSON 解析器读通
Get-ChildItem $dataDst -Filter *.json | ForEach-Object {
  $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "manifest 含 UTF-8 BOM（Go 无法解析）: $($_.Name)"
  }
  $c = [System.IO.File]::ReadAllText($_.FullName)
  if ($c -match 'C:\\Users') { throw "manifest 仍含绝对路径: $($_.Name)" }
  try { $null = ConvertFrom-Json -InputObject $c } catch { throw "manifest JSON 非法 ($($_.Name)): $($_.Exception.Message)" }
}
Ok "manifest 检查通过（无 BOM、无绝对路径、JSON 合法）"

# ---------------------------------------------------------------------------
Step "更新 QUICKSTART（trae 需要认证配置的说明）"
Copy-Item (Join-Path $Root 'start.bat') $StageDir -Force -ErrorAction SilentlyContinue
# start.bat 面向开发（会调用 bun/go）。分发版用专门的入口脚本覆盖：

Copy-Item (Join-Path $PSScriptRoot 'portable-start.bat') (Join-Path $StageDir 'start.bat') -Force
Copy-Item (Join-Path $PSScriptRoot 'portable-QUICKSTART.md') (Join-Path $StageDir 'QUICKSTART.md') -Force
Ok "启动脚本与快速上手文档"

# ---------------------------------------------------------------------------
Step "打包 zip"

$zip = Join-Path $ReleaseDir "BridgeHub-portable-$Version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Ok "产出: $zip ($size MB)"

Write-Host "`n完成。本地验证：解压 zip 到新目录并双击 start.bat" -ForegroundColor Green
