# 新机器部署（Windows）

这个仓库同时包含 OpenBiliClaw 源码和本地工作台启动壳（`local-workbench/`）。
小红书研究采集由 OpenBiliClaw 插件在你自己的小红书页面内完成（页面自己发请求、自己签名），不再需要 MediaCrawler。

## 0. 前置

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | 10/11 | |
| Python | 3.11+ | 安装时勾选 Add to PATH |
| Node.js | 22+ | 工作台脚本需要内置 fetch |
| Git | 任意 | |

## 1. 克隆

```powershell
git clone -b feat/unified-xhs-login https://github.com/jijiBoy9527/OpenBiliClaw.git openbiliclaw
cd openbiliclaw
```

## 2. Python 环境

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e .
```

（`pip install -e .` 会用 hatchling 安装 `openbiliclaw` 及全部运行依赖。）

## 3. 构建插件（采集必需）

研究采集依赖本分支的插件代码，旧插件不能用：

```powershell
cd extension
npm ci
npm run build
cd ..
# 把 manifest.json、dist/、icons/、popup/ 复制到 browser\openbiliclaw-extension\（或直接用 npm run package 生成的 zip 解压）
```

日常 Chrome 里已装旧版 OpenBiliClaw 的，也要在扩展管理页重新加载新版本。

## 4. Node 运行时（可选）

工作台优先用 `runtime/node-v22.19.0-win-x64/node.exe`，没有就用系统 `node`。
想用自带 Node 的话：

```powershell
# 解压到 runtime/node-v22.19.0-win-x64/
https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip
```

## 5. 浏览器与插件（登录/采集用）

- `browser/chrome-win64/`：Chrome for Testing 157.0.8103.50（来源见 `DEPLOYMENT.json`）
- `browser/openbiliclaw-extension/`：插件构建产物（第 3 步构建；旧机器上的旧版插件不能用于采集）

没有这两样时，服务能启动、推荐流能看，但**小红书登录和插件采集不可用**。

采集时插件会在浏览器里打开一个**前台**标签页，按设定间隔翻评论、点「展开回复」，完成后自动关闭。
小红书在后台标签页不会加载更多评论，所以采集期间请不要最小化浏览器窗口，也不要手动关闭这个标签页。

## 6. 启动

```powershell
# 在仓库根
local-workbench\start.cmd
```

首次启动会自动生成 `home/.openbiliclaw/config.toml`（数据目录指向本仓库 `data/openbiliclaw`），
并起本地服务 `http://127.0.0.1:8766`。

## 7. 打开

```
http://127.0.0.1:8766/web/
```

## 8. 首次配置

1. **设置 → 模型**：填 OpenAI 兼容的 base_url + API key，测试通过后保存
2. **设置 → 调度 → 后台 LLM 请求**：改成「开启」（默认是暂停，不开启不会评估候选）
3. **首页 → 开始生成首批推荐**：只勾小红书，跑完四阶段
4. **小红书登录**：设置 → 平台源 → 小红书 → 打开登录窗口并扫码

## 目录说明

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `src/`、`extension/`、`docs/` | 源码与文档 | 是 |
| `local-workbench/` | 启动壳、采集脚本、补丁 | 是 |
| `data/` | 抓取结果、推荐库、评论 | 否 |
| `home/` | `config.toml`（含密钥）、浏览器缓存 | 否 |
| `browser/` | Chrome 与插件、登录态 | 否 |
| `logs/`、`runtime/`、`.cache/` | 运行产物 | 否 |

## 常见问题

**启动报「研究工作台环境缺失」**
→ 第 2 步的 `.venv` 没建好，或 `pip install -e .` 失败。检查 `.venv\Scripts\python.exe` 是否存在。

**浏览器打开是白屏 / 500**
→ 看 `logs/research.stderr.log`。常见原因是 `local-workbench` 里的 JS 顺序与 `src/openbiliclaw/api/desktop_assets.py` 的清单不一致（两者必须同步改）。

**采集一直 pending / 提示插件未连接**
→ 插件没连上 8766，或浏览器没开。研究任务通过插件的实时连接下发，浏览器必须开着。

**采集提示「插件页面执行失败或超时」**
→ 插件不是本分支构建的新版本，或任务标签页被关掉、窗口被最小化。

**采集慢**
→ 正常。每个翻页 / 展开动作之间默认间隔 3 秒，可在采集表单里调；遇到验证码或风控会立即停止，不自动重试。
