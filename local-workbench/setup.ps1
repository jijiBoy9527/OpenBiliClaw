# 新机器一键部署：建 venv、装依赖、拉 MediaCrawler、启动工作台
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) { Write-Host "[失败] $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }

# ── 1. 前置检查 ──────────────────────────────────────────────
Step '检查环境'
foreach ($cmd in @('git', 'python', 'node')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "缺少 $cmd。请先安装：$cmd（Python 3.11+ / Node 22+ / Git）"
  }
}
$pyVersion = (& python --version 2>&1) -replace 'Python ', ''
$nodeVersion = (& node --version 2>&1) -replace 'v', ''
Write-Host "python $pyVersion / node $nodeVersion"

# ── 2. Python 依赖 ──────────────────────────────────────────
Step '安装 Python 依赖'
if (-not (Test-Path '.venv\Scripts\python.exe')) {
  python -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install -U pip --quiet
& .\.venv\Scripts\python.exe -m pip install -e . --quiet
if ($LASTEXITCODE -ne 0) { Fail 'pip install -e . 失败，检查网络或 pyproject.toml' }
Write-Host 'Python 依赖就绪'

# ── 3. MediaCrawler ─────────────────────────────────────────
Step '准备 MediaCrawler'
if (-not (Test-Path 'MediaCrawler')) {
  git clone https://github.com/jijiBoy9527/MediaCrawler.git MediaCrawler
}
Push-Location MediaCrawler
try {
  if (-not (Test-Path '.venv\Scripts\python.exe')) {
    python -m venv .venv
    & .\.venv\Scripts\python.exe -m pip install -U pip --quiet
    & .\.venv\Scripts\python.exe -m pip install -r requirements.txt --quiet
    if ($LASTEXITCODE -ne 0) { Fail 'MediaCrawler 依赖安装失败' }
  }
  Write-Host 'MediaCrawler 就绪'
} finally {
  Pop-Location
}

# ── 4. 浏览器与插件提示 ──────────────────────────────────────
Step '检查浏览器与插件'
$hasChrome = Test-Path 'browser\chrome-win64\chrome.exe'
$hasExt = Test-Path 'browser\openbiliclaw-extension\manifest.json'
if (-not $hasChrome) { Write-Host '[提示] 缺少 browser\chrome-win64（Chrome for Testing），小红书登录不可用' -ForegroundColor Yellow }
if (-not $hasExt) { Write-Host '[提示] 缺少 browser\openbiliclaw-extension（插件），采集不可用' -ForegroundColor Yellow }
if (-not ($hasChrome -and $hasExt)) {
  Write-Host '  最快办法：从旧机器的仓库根目录整份拷贝 browser\ 过来（含登录态，约 500MB）' -ForegroundColor Yellow
}

# ── 5. 启动 ─────────────────────────────────────────────────
Step '启动研究工作台'
Write-Host '打开 http://127.0.0.1:8766/web/  （Ctrl+C 停止）'
node local-workbench\scripts\research-workbench.mjs
