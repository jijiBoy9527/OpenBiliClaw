# 个人研究采集工作区：MediaCrawler + OpenBiliClaw 统一登录

## 新的日常入口：OpenBiliClaw 原生 UI

**双击 `D:\抓取\start.cmd` 或 `D:\抓取\workbench.cmd`**，打开 <http://127.0.0.1:8766/web/#research>。不需要让 AI 代执行命令。

1. 在 OpenBiliClaw 左侧打开“研究数据”，先在“设置 → 平台源 → 小红书”登录并确认 OpenBiliClaw 插件已连接。研究任务会复用该登录态，不再启动专用浏览器。
   首次需加载本地更新插件：Chrome/Edge 扩展管理页 → 开发者模式 → 加载 `D:\抓取\browser\openbiliclaw-extension`；默认连接 8766。已有 OpenBiliClaw 应替换/重载，不要两份并用。
2. “新建研究”输入一个关键词，先发现候选；也可粘贴完整笔记链接直接采评论。
3. 勾选内容，设置每篇一级评论数量、是否附带回复，点击“采集选中评论”。
4. 在界面查看进度、停止任务、搜索评论与回复、展开采集范围。
5. “导出数据包”获得 JSONL、CSV、manifest 和字段说明，可直接交给其他工具。
6. AI 整理是可选项：先配置兼容模型并明确同意发送评论，结果独立保存，附证据 ID。

已有“推拿”3 篇/51 条评论样本自动导入，不会重新请求平台。关闭页面不停止后台；电脑重启后再次双击入口。`start-legacy.cmd` 保留原 OpenCLI + DailyHotApi 启动行为。

需要关闭后台时，先在 UI 停止全部任务，再双击 `research-stop.cmd`；`stop.cmd` 则继续关闭旧 OpenCLI/DailyHotApi 服务。`status.cmd` 同时显示工作台状态。

当前源码由 `runtime/research-source.txt` 指向 `unified-xhs-login` 独立 worktree；依赖复用 `apps/OpenBiliClaw-research/.venv`。基于原研究独立 worktree，直接启动 OpenBiliClaw 原生应用，在侧边导航新增“研究数据”，沿用原品牌、主题、组件、推荐页与设置；已移除之前独立自制页面。采集仍由 MediaCrawler 独立执行。首次默认不配置推荐模型、不启用自动采集，原生界面如实提示推荐模型未配置，研究数据功能独立可用；推荐/画像需自行在原生设置中配置，未替用户初始化画像。没有复制 MediaCrawler GPL Web UI。说明：`D:\抓取\apps\OpenBiliClaw-research\docs\modules\research.md`。

新数据位于 `D:\抓取\data\research`；任务、评论和模型设置持久化在 SQLite。界面与导出保留笔记完整来源链接（含 xsec_token/xsec_source），不再拼接裸笔记 ID 链接；缺失时明确提示，链接可能过期或受登录限制。数据包含链接访问参数，请勿公开分享；旧包需重新导出。原 JSONL、Cookie、模型 key 和私有日志不提供下载；模型整理不发送来源链接。模型 key 使用 Windows DPAPI 保存。

UI 默认 HTTP 间隔 15 秒，可调 10–120 秒；旧命令入口未指定仍为 60 秒。两者共用账号锁与持久冷却；单批最多 40 请求，失败不自动重跑，不能理解为平台安全保证。每批都是有边界样本，不承诺全量。

本轮完成必要语法检查、调用链复查、服务启动并展示已有数据；未新增/执行测试、未追加平台采集、未调用收费模型。UI 发起采集、停止/重启、下载及模型完整链路尚未独立验收；本地代码未提交推送。

---

## 以下为历史 opencli 命令方案（保留，不属于当前 UI 登录入口）

2026-11-18 起，研究 UI 仅使用 OpenBiliClaw 插件，原 opencli 命令保留但不再作为 UI 前置步骤。`browser.cmd` 现在打开同一个平台源设置，不再创建另一套登录浏览器。

历史说明：**不再继续维护旧的自制抓取流程，改用 MediaCrawler 作为采集与存储底座，opencli 仅提供小红书浏览器登录态。**

- Fork：https://github.com/jijiBoy9527/MediaCrawler
- 上游：https://github.com/NanmiCoder/MediaCrawler
- 本地项目：`D:\抓取\MediaCrawler`
- 本地分支：`feat/xhs-opencli`；改造代码目前尚未提交或推送至 fork。
- 项目采用非商业学习许可证；本次用途为个人研究，保留原版权与许可。

## 对比结论

| 项目 | 适合负责的内容 | 本次取舍 |
| --- | --- | --- |
| opencli | 复用已登录 Chrome，提供通用浏览器命令 | 保留 Chrome、扩展和守护进程，读取 Cookie |
| MediaCrawler | 搜索、正文、真实评论 ID/回复目标、分页、结构化存储 | 作为新的底座 |
| 原工作区脚本 | DOM 小样本、相关词研究、自制报告 | 停止扩展，不再作为新入口 |

**替换边界不是“所有 Playwright 都能改成 opencli”。** 当前小红书客户端已使用 `xhshow` 签名与 HTTP 抓取，保存的 Playwright Page 没有实际被调用，因此能直接替换登录态获取，不必模拟 Playwright。其他平台未改，整个项目仍安装 Playwright Python 包，新小红书模式不启动它的浏览器。

旧流程的“最近一周筛选、相关词扩展、Markdown 分析报告”未迁入本次实现；不把新旧能力说成完全一致，也不把关键词搜索称为官方热榜。

## 使用

以下仅为仍需维护旧 opencli 环境时的历史命令；当前研究 UI 不使用它，也不会自动回退。

```powershell
# 默认每个词最多 3 条候选笔记，每篇最多 5 条一级评论。
& 'D:\抓取\mediacrawler.cmd' --keywords '推拿'

# 需要时附带楼中楼，仍然是有边界的研究样本。
& 'D:\抓取\mediacrawler.cmd' --keywords '推拿' --get_sub_comment yes
```

数据默认保存在 `D:\抓取\data\mediacrawler\xhs\jsonl\`，逐条追加；失败或请求额度耗尽可能只有部分正文/评论，JSONL 不提供跨批次自动去重。

新入口串行运行，每次元数据 HTTP 请求结束后至少间隔 60 秒，每进程最多 40 次；请求失败停止、不自动重试，不处理验证码或轮换账号。不是旧脚本的滚动小时/24小时额度，请不要通过连续重启扩大采样。媒体下载默认关闭。

完整对比、独立 fork 的用法、依赖复现与限制：`D:\抓取\MediaCrawler\docs\OPENCLI.md`。

## 旧内容处理

- 原采集数据、Chrome 登录态、限速历史均未删除或迁移。
- 原脚本仍保留，但不作为新方案；新旧入口共用任务锁，禁止同时运行。
- 旧说明移至 `D:\抓取\README-opencli-legacy.md`，仅供查阅历史部署。旧命令额度不能视作新 HTTP 链路的额度。
- DailyHotApi 保留但不是新方案的依赖，没有继续扩展。
- 安装、虚拟环境、缓存、临时文件和结果都放在 D 盘工作区，没有新装全局包或 Playwright 浏览器。Python 复用本机已有 3.11。
- Cookie 不写入配置、文件或输出日志；浏览器目录、缓存、数据、日志仍应视为私有内容，不上传。

## 当前完成边界

已完成 GitHub fork、本地改造及 Python/Node 依赖安装，并完成源码调用链复查与改动文件的必要语法检查。

2026-11-17 经用户明确授权，已用新入口实际采集“推拿”关键词样本：3 篇笔记、15 条一级评论、36 条回复。进程正常结束，评论 ID 唯一且关联核对通过。报告位于 `D:\抓取\data\mediacrawler\runs\tuina-20261117T020341Z\采集报告.md`。

本批是关键词相关样本，不是精确话题标签筛选；3 篇中 1 篇含“小儿推拿”标签，其余为肩颈、腰部按摩相关内容。未新增测试源码或运行测试套件，未验证其他平台、关键词和持续采集。本地改动尚未提交、推送。

