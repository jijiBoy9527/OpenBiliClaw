# 研究数据工作台（本地改造，2026-11-17）

## 已实现能力

| 功能 | 边界 |
| --- | --- |
| UI 搜索候选、勾选采集、粘贴完整链接 | 当前仅小红书；关键词相关，不是精确标签过滤 |
| 评论与回复查看、文字/ID 搜索、分页 | 同批按平台 ID 去重；跨批保留快照 |
| 串行任务、停止、重启中断标记 | 不自动重跑，不自动绕过平台限制；不承诺自动断点续采 |
| 已有 MediaCrawler 批次导入 | 仅工作区 `data/mediacrawler/runs/*/xhs/jsonl`，不导入旧 DOM 样本 |
| ZIP 导出 | JSONL、CSV、manifest、字段与范围说明；保留完整笔记链接，移除昵称/独立用户标识字段 |
| 完整来源链接 | 沿用 MediaCrawler 的 note_url，保留 xsec_token/xsec_source；缺失时为 null，不再用裸 ID 拼接 |
| 可选模型分析 | 复用 `llm/openai_provider.py`，结果独立保存，校验证据 ID |
| 一键登录 | 首页、设置、研究共用同一按钮动作与浏览器 profile；自动加载唯一 OpenBiliClaw 插件并限时检查心跳 |
| 推荐页衔接 | 完整 OpenBiliClaw 启用本模块后，小红书卡片可转入工作台；不点击即采集 |

## 启动与依赖

本机快捷入口：`D:\抓取\start.cmd` 或 `D:\抓取\workbench.cmd`，访问 <http://127.0.0.1:8766/web/#research>。
关闭页面不会停止服务或队列；电脑重启后再次双击入口。登录可直接在首页初始化清单或“设置 → 平台源 → 小红书”点击“打开小红书登录”。按钮会启动工作区统一登录窗口并自动加载 OpenBiliClaw 插件，登录后自动检查连接；研究任务按次读取登录态，不再维护 opencli 入口。

统一登录改造在独立 worktree `C:\Users\鸡哥\.codex\worktrees\unified-xhs-login\OpenBiliClaw-research`，分支 `feat/unified-xhs-login`。原研究改动作为依赖基线保留，原工作区没有被覆盖；启动器通过 `runtime/research-source.txt` 选择源码，复用原 `.venv`。

直接使用 OpenBiliClaw 原生 `/web/` 桌面应用，侧边导航增加「研究数据」，复用既有品牌、主题、设置、任务卡、表单、overlay 和 toast。原推荐、内容库、聊天与设置仍在，不是另起一套 UI，也不是只复制上游 CSS。旧 `/research/` 重定向到 `/web/#research`。

复现环境：在上述 worktree 内创建 `.venv`，使用 `python -m pip install -e .` 安装完整项目；`PIP_CACHE_DIR`、`UV_CACHE_DIR`、`TEMP`、`TMP` 指向工作区缓存。MediaCrawler 保留自己的 `.venv`。设置 `PYTHONPATH=<worktree>/src`、`RESEARCH_WORKSPACE=D:\抓取`、`OPENBILICLAW_PROJECT_ROOT=D:\抓取\home\.openbiliclaw`、`OPENBILICLAW_FISH_LOOP_DISABLED=1`，执行：

```powershell
python -m uvicorn openbiliclaw.research.api:create_app --factory --host 127.0.0.1 --port 8766 --no-access-log
```

`research.api:create_app` 委托原生 `api.app:create_app`，后者按 `RESEARCH_WORKSPACE` 挂载同一模块，不重复启动服务。首次启动器仅在 config.toml 不存在时写入空推荐模型链、关闭调度和平台源；配置/数据都在 D 盘，已有配置不覆盖。模型未配置时原样显示 degraded 诊断，推荐/画像暂停；研究队列不依赖此注册表，可采集和导出，分析需另外配置并同意。用户可通过原生模型设置配置推荐后恢复上游流程，本次没有替用户初始化画像。首次完整依赖冷启动可能较慢，启动器最多等待 120 秒，期间不要重复启动。

不新增移动 Web或原生 CLI 研究界面；插件只新增登录态交接，不增加研究 UI，不启用公开互动。本工作区仅 Windows 本机，不承诺 Docker/打包安装器支持。操作系统文件锁拒绝同一数据目录多实例。

## 架构与数据流

```text
推荐卡片 / 搜索主题 / 用户完整链接
                  ↓
原生 /web/「研究数据」→ 原生认证 + loopback API → SQLite 持久队列（单 worker）
                  ↓
XhsPageBridge → runtime stream `xhs_research_task_requested`（每篇笔记 / 每次搜索一个步骤）
                  ↓
OpenBiliClaw 插件 → 前台任务标签页（小红书页面自己请求、自己签名）→ 翻评论 / 展开回复 / 滚动搜索
                  ↓ MAIN world 截获页面自身的 search / comment / sub-comment 响应
POST /api/research/task-result → xhs_page 映射为 JSONL + 分页覆盖事件（字段沿用原 MediaCrawler 格式）
                  ↓
白名单字段归一化 → 数据集快照 → ZIP(JSONL + CSV + manifest)
                  ↓ 用户明确同意后可选
OpenBiliClaw OpenAIProvider → 有证据 ID 的 findings → 单独导出，包含源数据
```

`data/research/research.sqlite3` 存任务、事件、记录、模型设置。`data/research/runs/<uuid>` 存原始 JSONL、结构化进度和私有日志。原始 JSONL/私有日志可能包含签名链接，不对网页提供，也不能上传。
`Store` 管快照，`Service` 管队列与进程，`api.py` 管接口边界，`links.py` 共用笔记链接校验，原生 desktop `research.js` 管研究 UI，`analysis.py` 管可选分析及 DPAPI，`export.py` 管交付契约。没有额外 Redis/Celery。

## API

所有 API 在 `/api/research`；只接受直接 loopback 请求和本机 Host。除插件一次性会话响应外，不接受跨站来源；普通写请求必须含 `X-Research-Request: 1`；原生认证继续生效（本机请求带 `X-OBC-Auth: 1`）。研究请求固定同源，不跟随用户配置的远程推荐端点，不开放研究跨域访问。

| 方法 / 路径 | 用途 |
| --- | --- |
| GET `/status`, `/jobs`, `/jobs/{id}` | 环境和任务 |
| GET `/jobs/{id}/records?kind=contents|comments|findings&q=&offset=0&limit=50` | 数据分页（最大 200） |
| GET `/jobs/{id}/events` | 最近 100 条安全进度事件 |
| POST `/discover` | `{topic,max_notes:1..20,interval:10..120}`，不抓评论 |
| POST `/collect` | `{topic,source_dataset_id,content_ids,max_comments:1..100,include_replies,interval}` 或 `{topic,urls,...}`；最多 10 篇 |
| POST `/jobs/{id}/stop` | 取消排队 / 停止本任务进程树，保留已写文件 |
| POST `/import`, `/login`, `/browser` | 导入本地批次 / 启动工作区统一登录窗口并自动加载 OpenBiliClaw 插件；`/browser` 保留兼容 |
| POST `/task-result` | 仅本机插件 Origin 回传尚未消费的随机步骤 ID；请求体上限 16 MB，晚到 / 重放结果返回 409 |
| GET/PUT `/model` | 配置兼容模型，key 不返回，Windows DPAPI 加密 |
| POST `/analyze` | `{dataset_id,goal,consent:true}`；锁定此次同意的模型配置，不随排队期间设置变化而换目标 |
| GET `/jobs/{id}/export` | 任务结束后的 ZIP 稳定快照 |

## 输出契约

`schema_version=research.dataset.v1`；ID 始终字符串，实体关联键 `(platform, content_id/comment_id)`。
contents: `content_id,url,title,text,tags,type,published_at_raw,source_keyword,likes,reported_comment_count,collected_at,video_transcribed`。
comments: `comment_id,content_id,parent_comment_id,root_comment_id,is_reply,text,cleaned_text,published_at_raw,likes,reported_reply_count,collected_at`。
findings: `finding_id,source_dataset_id,category,summary,evidence_comment_ids,model,analysis_version,created_at`。

未知值保留 null。`collected_at` 来自 MediaCrawler 的 `last_modify_ts`，不是导入时间。历史根评论只有在同一内容内可以沿真实父链追溯时才补齐，无法确定时保持 null。
`contents.url` 修正为采集时的完整 `note_url`，包括原有 `xsec_token`、`xsec_source` 等参数；校验来源域名、笔记路径、ID 一致性和访问参数完整性。它不是去签名的永久公开链接，不保证不过期或脱离登录可用。缺失/无效时为 null，UI 不提供伪造的裸链接，也不允许勾选采集。启动时从历史批次原 JSONL 恢复旧 URL 字段；原文件缺失时仅保留库内已有的有效完整链接，不能恢复的显示缺失，不重新采集。
选中采集、UI 原文和 ZIP（JSONL/CSV）使用同一持久化 URL；导出包含访问参数，请勿公开分享。已下载的旧包不会自动变更，需要重新导出。模型整理只发送评论与关联 ID，不包含来源 URL；Cookie 和模型 Key 仍不导出。
同批重复导入更新同一 ID；跨批为独立快照，下游合并需要选定时间策略。纯 @人原文仍保留，由分析层区分，不擅自删除可能有用的原始数据。
CSV 列表使用 JSON 字符串，公式前缀加单引号；自动化消费优先 JSONL。导出原文无用户 ID/昵称字段，不代表文字中绝对不含个人信息。

## 状态与范围

状态：queued → running → completed/partial/failed/cancelled；服务重启将遗留活动任务标 interrupted，先核实进程归属并停止本任务遗留进程树，不自动重抓。
completed 只表示配置范围结束，不代表平台全量。manifest 的 `coverage` 记录一级评论是否分页结束/截断、回复线程、不可访问内容、缺少完成记录与退出码；平台显示数量不等于可获取数量。
失败/停止后可以导出已入库记录。每个步骤的页面请求预算按范围推算（评论每页 10 条、搜索每页 20 条，另加 2 次首屏与结束探测；附带回复时每条一级评论最多再展开一次）；任务显式给出 `max_requests` 时作为全任务上限。

页面动作（翻页、展开回复、搜索滚动）默认间隔 3 秒，表单 `interval` 可调 0–120 秒，插件侧下限 1.5 秒；步骤之间的冷却写入研究库 `xhs-page-pacing` 设置，跨任务和重启保持。插件与其他自动任务标签页共用调度互斥锁，同一时间只跑一个小红书标签页。
这是保护性配置，不代表平台授权或安全频率保证。不能绕过验证码、自动换账号或自动连续重试。

## 模型与安全

原始采集无需模型。用户每次分析明确同意发送文字和关联 ID，可能产生费用。保存设置不调用模型。
研究模块没有工具执行、自动发帖、私信或 Blue Fish 操作；工作区启动器禁用 Blue Fish，默认平台源和调度关闭。评论是不可信输入。模型输出做字段与证据 ID 校验，不合规批次失败，不编造替代结果。
整体分析任务不自动重试；复用的上游 provider 仍可能为格式/参数兼容做有限协商请求，单批外层 180 秒超时，用户须留意模型计费。此前已完成批次的 findings 保留。
仅 Windows 本机支持 DPAPI；本模块不承诺 Docker/远程访问。研究采集不再调用 MediaCrawler；仍可导入历史 MediaCrawler JSONL 批次。

## 当前交付边界

未新增或执行测试，没有启动初始化、新采集或分析任务。完成必要语法检查、源码调用链复查与服务更新；已有样本保持不变。采集 UI、停止/重启、ZIP 下载、模型往返及完整推荐页桥接尚未做独立端到端验收；不据此宣称所有操作已经实测通过。

## 统一登录（2026-11-18）

首页初始化清单和“设置 → 平台源 → 小红书”共用同一个“打开小红书登录”动作；研究页也直接调用相同登录动作，不再只跳转设置。选用 OpenBiliClaw 插件而非 opencli：原平台功能已经依赖该插件，后者无法取代原平台任务桥；两套插件并存只会增加连接与账号维护。

> 2026-11-19 起本段的 Cookie 交接已移除，见下文「页面内采集」。登录仍走同一个插件与浏览器 profile。

工作区会启动随应用管理的 Chrome for Testing 登录窗口，使用稳定的 `browser/openbiliclaw-profile` 并自动加载本次构建的 OpenBiliClaw 插件；不会读取或覆盖日常 Chrome/Edge profile，也不启动 opencli。后端固定为 `127.0.0.1:8766`，原浏览器 profile 与旧脚本仅作历史保留。原平台源开关仅控制推荐/画像接入，不因研究任务而自动打开或导入个人收藏。

本地插件目录：`D:\抓取\browser\openbiliclaw-extension`，备份安装包：`D:\抓取\downloads\OpenBiliClaw-unified-xhs-local.zip`。本机包默认端口为 8766；统一登录窗口为应用管理的独立 profile，用户不需要手工安装扩展或配置端口。日常浏览器手动接入仍可使用同一插件，但不是本地按钮的前置步骤。

已部署到本机服务，执行过打开登录窗口操作；最新来源状态已收到插件上报的已登录心跳（`verification=verified`，`profile/bootstrap.ready=true`）。窗口页面未能通过当前电脑工具读取（Chrome 窗口句柄归属报错），没有代用户扫码或运行初始化/新采集；登录心跳不等于正文/评论 HTTP 或行为采集已验证可用。

### 登录检查与初始化边界

前端点击登录后最多约 3 分钟检查连接，验证请求之间至少间隔 10 秒；只执行插件布尔心跳，不采集平台、不调用模型。`outcome=verified` 且非重放才显示本次已连接，`failed` 表示插件已回报但账号未登录，`indeterminate` 表示尚无法确认。等待超时保留真实状态，可再次登录或手动检查，不无限轮询，也不自动初始化。

`POST /api/init` 对选中的小红书先请求插件心跳（沿用 10 秒防抖）；单选未就绪时直接返回 409 `xhs_login_required` / `xhs_connection_unconfirmed`，不启动长任务。混选跳过未就绪的小红书并返回 warning，但保留用户显式启用来源的选择。若连接后任务仍返回空、超时或失败，共享 CLI 流水线分别报告 `xhs_bootstrap_empty/timeout/failed/skipped`（仅小红书单来源时）；不把读不到行为一概归为未登录。页面保留并标注上次初始化结果，不自动清除失败记录。

推荐模型未配置时，本地研究部署仍允许小红书布尔心跳写入；runtime stream 保留 degraded 诊断，同时订阅事件 hub，确保登录验证与研究会话交接不被模型配置阻断。普通非研究部署的 degraded 行为不变。

### 画像初始化与研究采集不是同一操作

首页“生成首批推荐”会读取所选平台个人行为、调用推荐模型分析兴趣并生成画像/推荐；当前默认选择已启用的小红书。待评估候选存在不代表画像已完成，不能隐藏首页开始入口。若只需按主题采集笔记和评论，请在“研究数据 → 新建研究”创建发现/采集任务，无需先生成个人画像，也不需要 Embedding；研究模型整理仍按次征得同意。

## 页面内采集（2026-11-19）

研究采集不再由后端或 MediaCrawler 发 HTTP 请求，也不再把小红书 Cookie 交给任何进程。

| 环节 | 实现 |
| --- | --- |
| 下发 | `Service.crawl` 把任务拆成步骤：发现 = 一次搜索页，评论采集 = 每篇笔记一页；`XhsPageBridge` 通过 runtime stream 发 `xhs_research_task_requested`，停止任务时发 `xhs_research_task_cancelled` |
| 执行 | 插件 `background/xhs-research-runner.ts` 仅在后端为 loopback 时，开一个静音的前台任务标签页（带 `openbiliclaw_xhs_task` 标记，不计入被动行为）；`content/xhs/research-executor.ts` 按间隔滚动评论区 / 搜索页、点击「展开回复」 |
| 取数 | `main/xhs-token-sniffer.ts` 在 MAIN world 截获页面自己发出的 `search/notes`、`comment/page`、`comment/sub/page`、`feed` 响应；只有被本标签页研究执行器激活后才转发原始响应，笔记正文读取页面 `__INITIAL_STATE__` |
| 停止 | 登录弹窗、验证弹窗、HTTP 461/471、接口码 300011/300012/300013/300015 或 -100/-101/-104 立即结束本步骤，后端记录 `login_required` / `platform_restricted` 并停止整个任务，不自动重试 |
| 落库 | `research/xhs_page.py` 把页面响应映射成原 MediaCrawler JSONL 字段，写入 `runs/<job>/xhs/jsonl/` 与 `progress.jsonl`，`Store.ingest`、覆盖率清单与 ZIP 导出不变 |

限制：任务标签页必须在前台可见——小红书在隐藏标签页不加载更多评论，最小化窗口会导致步骤超时。搜索卡片只含标题、作者、互动数和封面，正文、标签与发布时间要在评论采集（打开笔记页）时才有。浏览器必须开着并连接本机后端，否则任务直接失败并提示插件未连接。

验证状态：基于代码阅读与静态检查完成，按本机系统规则未运行测试，也未在本机对真实小红书页面跑过采集；页面选择器（`.note-scroller`、`.show-more`）与接口路径需要在实际设备上验收。
