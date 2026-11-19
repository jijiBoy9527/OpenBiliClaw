#!/usr/bin/env bash
# Linux/macOS 版 workbench.cmd：启动研究工作台；参数原样透传（--status / --stop / --no-open / --settings）。
exec node "$(dirname "$(readlink -f "$0")")/scripts/research-workbench.mjs" "$@"
