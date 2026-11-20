#!/usr/bin/env bash
# Linux/macOS 版 setup.ps1：建 venv、装依赖、启动工作台（小红书采集由插件在页面内完成）。
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf '[失败] %s\n' "$1" >&2; exit 1; }

step '检查环境'
for cmd in git node; do
  command -v "$cmd" >/dev/null || fail "缺少 $cmd（Python 3.11+ / Node 22+ / Git）"
done
PY=$(command -v python3.12 || command -v python3.11 || command -v python3 || true)
[ -n "$PY" ] || fail '缺少 python3'
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail "需要 Python 3.11+，当前 $("$PY" --version)"
echo "python $("$PY" --version | cut -d' ' -f2) / node $(node --version)"

step '安装 Python 依赖'
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install -U pip --quiet
.venv/bin/python -m pip install -e . --quiet || fail 'pip install -e . 失败，检查网络或 pyproject.toml'

step '检查浏览器'
if [ ! -x browser/chrome-linux64/chrome ]; then
  echo '未找到 browser/chrome-linux64/chrome（Chrome for Testing linux64）。'
  echo '服务可启动、推荐流可看，但小红书登录/插件采集不可用。'
fi

step '启动研究工作台'
exec local-workbench/workbench.sh
