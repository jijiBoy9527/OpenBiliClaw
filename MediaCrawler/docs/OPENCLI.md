# MediaCrawler + opencli：个人研究版

本修改继续遵守项目根目录的 **NON-COMMERCIAL LEARNING LICENSE 1.1**，仅用于非商业个人学习研究，不用于大规模采集。版权属于原作者，保留原许可证与声明。

## 结论与对比

基于上游提交 `306ab4ca26c0e44fb87ede0e40e98748752815a6`、本工作区 OpenCLI 2.0.3 源码核对。小红书适合替换登录态获取环节，不应把整个 MediaCrawler 改成调用 `opencli xiaohongshu search/note/comments`。

| 维度 | 原工作区 opencli 抓取脚本 | MediaCrawler 上游 | 本 fork 的小红书 opencli 模式 |
| --- | --- | --- | --- |
| 定位 | 浏览器命令串联、DOM 小样本 | 多平台采集与结构化存储 | 保留 MediaCrawler，只替换浏览器登录态入口 |
| 浏览器 | Chrome + opencli 扩展/守护进程 | Playwright/CDP 管理上下文与登录 | 用户手动登录，扩展只读取当前站点 Cookie |
| 搜索、正文 | 站点适配器、页面结构解析 | 小红书 HTTP API + HTML 解析 | 复用 MediaCrawler 客户端，不调用旧站点适配器 |
| 签名 | 由站点适配器处理 | 当前小红书已使用 `xhshow` 算法 | 仍使用 `xhshow`，不是用 opencli 替换签名 |
| 评论、回复 | 旧 DOM 结果无真实评论 ID，无法精确还原链 | 接口提供评论 ID 和回复目标，支持游标分页 | 保留结构化字段和上游脱敏逻辑；按配置采样 |
| 存储 | 自制每批 JSON 和报告 | JSON/JSONL/CSV/SQLite 等 | 复用现有存储；文件追加不等于跨批次去重 |
| 时间筛选 | 原脚本有最近一周筛选 | 当前小红书 API 搜索封装未传发布时间过滤 | 本次未实现该过滤，不声称与旧脚本筛选等价 |
| 相关词与分析报告 | 有关键词扩展、分析与 Markdown 报告 | 不提供旧工作区的同一流程 | 不迁入旧流程，只完成采集底座切换 |

### 为什么能替换

当前 `media_platform/xhs/client.py` 并没有调用保存的 `playwright_page`：签名已改为纯算法，详情、搜索、评论、创作者走 HTTP。因此从扩展读取 Cookie 后可以直接复用该客户端，不必模拟一整套 Playwright Page/BrowserContext，也不必翻译所有浏览器 API。

`tools/opencli_session.mjs` 使用 OpenCLI 导出的 `Page.getCookies({url})`，包含 HttpOnly Cookie，不使用 `document.cookie`。Cookie 仅通过子进程私有 stdout 管道传回 Python 内存，不生成 Cookie 文件，也不打印原始响应。不要单独执行脚本并将 stdout 写入共享日志。

### 没有替换的部分

- 只改小红书。其他平台仍保留 Playwright 与现有登录逻辑，未确认等价替换能力。
- 项目仍安装并导入 Playwright Python 包；新小红书模式不启动其运行时、不下载 Playwright 浏览器。不是全项目去除依赖。
- 不自动登录、收取短信、识别验证码、轮换账号或代理，不改写原浏览器 Cookie。
- `LOGIN_TYPE`/`COOKIES` 不作用于 opencli 模式；请在自己的浏览器中完成登录。
- 上游的昵称脱敏、用户 ID 哈希、存储字段保留；不是恢复旧脚本的作者主页或原始昵称。
- 接口可分页不等于能完整抓取所有评论；已删除/无权限内容、配置上限、访问限制都可能导致部分结果。

## 当前工作区使用

1. 使用 `D:\抓取\browser.cmd` 打开现有专用 Chrome（会启动工作区 opencli 守护进程，不启动 DailyHotApi）。
2. 在该浏览器中自行登录小红书、完成人工验证，并保持浏览器打开。
3. 使用新的入口，不再调用旧的 `collect-xhs.cmd` / `research-xhs.cmd`：

```powershell
# 默认每个关键词最多处理 3 条候选笔记，每篇最多 5 条一级评论。
& 'D:\抓取\mediacrawler.cmd' --keywords '推拿'

# 同时读取这 5 条一级评论对应的楼中楼，仍受本批请求上限约束。
& 'D:\抓取\mediacrawler.cmd' --keywords '推拿' --get_sub_comment yes

# 指定少量完整笔记链接，请使用实际搜索结果，保留 xsec_token。
& 'D:\抓取\mediacrawler.cmd' --type detail --specified_id '实际完整笔记URL'
```

结果默认位于 `D:\抓取\data\mediacrawler\xhs\jsonl\`，文件名由上游按采集类型、内容/评论和日期生成，逐条追加保存。新搜索模式每篇正文保存后即采评论，之后才进入下一篇，后续失败不抹除已落盘记录。停止时可能只有正文或部分评论，不能把进程结束或已有文件当成全部采集成功。

旧数据、浏览器登录目录、限速历史都保留，未做数据迁移。新旧入口共用工作区任务互斥锁，不能同时运行。异常退出遗留锁时须先人工确认进程已经停止，不能在旧的 `xhs-safety.cmd resume` 中解除仍在工作的锁。

### 访问保护与边界

- 仅串行，无独立代理；不改变浏览器与 HTTP 的网络出口配置。
- 登录检查、搜索、详情、HTML、评论分页均通过同一请求边界：前一请求结束后至少等 60 秒，发出前才签名，避免等待使签名过期。
- 每进程最多 40 次元数据 HTTP 请求，含登录检查；达到上限抛错停止，保留已落盘记录。不是旧脚本的每小时/24小时持久额度，重启不会保留新计数，请勿连续重启扩大采样。
- 新模式请求失败不自动重试，验证码、401/403/429、账号/IP限制会停止，不自动跳过后继续抓取。明确不存在的笔记按上游语义跳过。
- 媒体下载默认关闭，是独立下载器，不计入这里的 40 次元数据请求；如果主动开启，媒体流量与磁盘容量另行计算。
- 初次 Cookie 读取不发起站点导航；用户浏览器自身后台流量、手动操作、其他工具不受这个限速器控制，不能保证不触发平台限制。

这些保护不等于平台授权或账号安全保证。请遵守目标平台规则，仅采集有权访问的公开研究样本。

## 独立 fork 使用

先按上游说明准备 Python 依赖，并在本仓库执行 `npm ci --omit=dev --ignore-scripts` 安装固定版本 opencli。另行安装并连接 opencli Browser Bridge 扩展/守护进程，手动登录。设置：

```powershell
$env:XHS_BROWSER_BACKEND = 'opencli'
$env:OPENCLI_NODE_BINARY = 'node'  # 可替换为 Node 可执行文件的绝对路径。
# 多 profile 时填实际 context ID；不是显示名称或别名。
# $env:OPENCLI_CONTEXT_ID = '实际扩展contextId'
python main.py --platform xhs --keywords '推拿' --crawler_max_notes_count 3 --max_comments_count_singlenotes 5
```

`OPENCLI_CONFIG_DIR` / 守护进程端口等应与现有 opencli 安装一致。单 profile 可不设置 context ID；多 profile 无法唯一确定时会失败，不猜测使用哪个账号。

不设置 `XHS_BROWSER_BACKEND` 时仍使用原 Playwright 路径。工作区新入口固定设置为 `opencli`，并将缓存、临时文件、运行结果放在 D 盘工作区内；不覆盖系统环境变量或全局安装。

### 本工作区 Python 依赖复现

上游锁文件的清华镜像下载曾返回 403，因此当前环境用 uv 从上游锁文件导出固定版本，再从官方 PyPI 安装，未修改上游 Python 依赖版本：

```powershell
$env:UV_CACHE_DIR = 'D:\抓取\.cache\uv'
$env:TEMP = 'D:\抓取\.cache\temp'
$env:TMP = $env:TEMP
uv export --project 'D:\抓取\MediaCrawler' --frozen --no-dev --format requirements-txt --no-hashes --output-file 'D:\抓取\.cache\mediacrawler-requirements.txt'
uv pip sync --python 'D:\抓取\MediaCrawler\.venv\Scripts\python.exe' --index-url https://pypi.org/simple 'D:\抓取\.cache\mediacrawler-requirements.txt'
```

`.venv` 已在 D 盘创建，复用本机已有 Python 3.11；没有新装全局 Python、npm 包或下载 Playwright Chromium。Windows 自身和已有 Python 的系统写入不受工作区缓存设置完全约束。

## 完成与未验证边界

已完成源码调用链对比、fork、本地接入代码和依赖部署，并完成改动文件必要的语法检查及 Git diff 审阅。

2026-11-17 经用户明确授权，使用新入口完成一批真实小红书采集：关键词“推拿”，3 篇正文、15 条一级评论、36 条回复；进程退出码 0，登录接口检查通过，评论 ID 唯一，笔记和回复关联核对通过，日志无 WARNING/ERROR。本批未触发程序报告的验证码或访问限制，不代表长期运行无风险。

结果位于 `D:\抓取\data\mediacrawler\runs\tuina-20261117T020341Z\`，详见其中的 `采集报告.md` 和 `summary.json`。本次是关键词相关样本，不是精确话题筛选（1 篇含“小儿推拿”标签，另 2 篇为肩颈/腰部按摩）。未新增测试源码或执行测试套件，未验证其他平台、关键词、全量评论或长期运行。

来源：
- https://github.com/NanmiCoder/MediaCrawler
- https://github.com/jackwener/opencli
- https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect-over-cdp
# 研究工作台接入补充（2026-11-17）

工作区 `start.cmd` / `workbench.cmd` 提供独立 UI，调用本项目已有 CLI，不改变其他平台。
`XHS_OPENCLI_REQUEST_INTERVAL` 可通过环境变量设置 10–120 秒，未设置仍 60 秒；UI 默认 15 秒。workspace launcher 设置 `XHS_OPENCLI_STATE_PATH`，持久化冷却时间且继续共用账号锁，避免新批次清零间隔。
`XHS_RESEARCH_PROGRESS` 为可选 JSONL 进度路径，仅写事件、内容/评论 ID 和分页范围，不写 Cookie/签名参数。评论存储新增真实 `root_comment_id`；缺失关系不猜测。
opencli detail 模式逐篇持久化，失败保留此前笔记及评论。工作台按限定范围和进度判断 partial/completed，不以 exit 0 冒充全量。
未复制或修改本项目 GPL Web UI。个人研究、上游非商业许可保持不变。本轮没有追加实采或运行测试。

## OpenBiliClaw 统一登录（2026-11-18，本地未发布）

研究 UI 改用 `XHS_BROWSER_BACKEND=openbiliclaw`，从 OpenBiliClaw 插件的同一个小红书登录账号按任务读取一次会话，经后端 → Node launcher → Python 的私有 stdin 传递。`tools/obc_session.py` 不保存、不打印 Cookie。该模式与旧 opencli 模式共用串行、持久冷却、40 次请求预算、无自动重试及评论完成记录。原 Playwright/其他平台保持不变。没有会话时失败，不回退另一套登录入口。

本机“设置 → 平台源 → 小红书”为唯一 UI 登录设置；研究页仅链接至该设置。旧 opencli 说明仅供历史命令维护，不是当前 UI 前置条件。需更新本地 OpenBiliClaw 插件与后端；未执行真实平台采集或测试。
