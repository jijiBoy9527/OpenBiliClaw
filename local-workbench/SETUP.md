# 新机器部署（Windows）

这个仓库同时包含 OpenBiliClaw 源码和本地工作台启动壳（`local-workbench/`）。
MediaCrawler 作为独立仓库单独拉取，放在工作区根的 `MediaCrawler/` 下。

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

## 3. MediaCrawler（抓取手）

```powershell
git clone https://github.com/jijiBoy9527/MediaCrawler.git MediaCrawler
cd MediaCrawler
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

> 如果旧机器上已有可用的 `MediaCrawler/`（含 `.venv`），可以直接拷整个目录过来，跳过这一步。

## 4. Node 运行时（可选）

工作台优先用 `runtime/node-v22.19.0-win-x64/node.exe`，没有就用系统 `node`。
想用自带 Node 的话：

```powershell
# 解压到 runtime/node-v22.19.0-win-x64/
https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip
```

## 5. 浏览器与插件（登录/采集用）

- `browser/chrome-win64/`：Chrome for Testing 157.0.8103.50（来源见 `DEPLOYMENT.json`）
- `browser/openbiliclaw-extension/`：插件构建产物（`extension/` 源码构建，或从旧机器复制）

没有这两样时，服务能启动、推荐流能看，但**小红书登录和插件采集不可用**。

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

**采集一直 pending**
→ 设置 → 调度里的「后台 LLM 请求」没开，或插件没连上 8766。

**采集慢**
→ 正常。一次浏览会话 15 个请求上限，每次间隔随机 45–75 秒。
