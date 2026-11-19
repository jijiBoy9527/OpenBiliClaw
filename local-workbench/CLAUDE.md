# CLAUDE.md (local-workbench)

`local-workbench/` 是本地研究工作台的启动壳：Node 脚本 + 平台启动器，把仓库根当作工作区根，驱动 OpenBiliClaw 研究 API（8766）、MediaCrawler 与（历史方案）OpenCLI / DailyHotApi。后端核心代码在仓库根 `src/`，见根目录 `CLAUDE.md`。

## 布局

- `scripts/*.mjs` — 全部逻辑。`environment.mjs` 是公共入口：解析 `root`、隔离 HOME/缓存目录、导出平台辅助函数，**每个脚本都先 import 它**。
- `*.cmd` — Windows 启动器；`workbench.sh` / `setup.sh` — Linux/macOS 对应物。
- `setup.ps1` / `setup.sh` — 一键部署；`SETUP.md` — 完整说明（Windows 为主）。
- `DEPLOYMENT.json` — 已部署组件的来源、哈希与采集护栏记录；`patches/` — OpenCLI 补丁。

## 平台约定

不要在脚本里写死 `Scripts\python.exe`、`chrome-win64`、`powershell.exe`、`rundll32.exe`、`;` 分隔 PATH 或 `..\`。统一用 `environment.mjs` 的：

| 辅助 | 作用 |
|---|---|
| `isWindows` | 平台判断 |
| `venvPython(dir)` | `Scripts/python.exe`（Win）或 `bin/python` |
| `chromeExecutable()` | `browser/chrome-win64/chrome.exe` 或 `browser/chrome-linux64/chrome`；其他平台抛错 |
| `processInfo(pid)` | 进程命令行/父进程：Win 走 CIM，Linux 读 `/proc` |
| `openUrl(url)` | `rundll32` / `open` / `xdg-open` |

Linux Chrome for Testing 下载地址形如 `https://storage.googleapis.com/chrome-for-testing-public/<版本>/linux64/chrome-linux64.zip`，解压到 `browser/`。OpenCLI 那条历史链路里 DPAPI 等 Windows 专属能力不在此约定范围内。

## 运行

```bash
local-workbench/setup.sh            # 首次部署
local-workbench/workbench.sh        # 启动并打开 http://127.0.0.1:8766/web/#research
local-workbench/workbench.sh --status | --stop | --no-open
```

## 注意

- 小红书采集有账号锁（`.cache/xhs-rate.lock`）和速率护栏（`xhs-client.mjs` / `xhs-safety.mjs`），不要绕过或并行启动。
- `home/.openbiliclaw/config.toml` 保存模型 key 与调度开关，不在仓库中，不要提交。
- 改动脚本后用 `node --check scripts/<file>.mjs` 做语法检查。
