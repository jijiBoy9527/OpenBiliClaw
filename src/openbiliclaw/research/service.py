"""Single local queue; every XHS read runs inside the user's own page via the extension."""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

from .analysis import analyze
from .store import Store
from .xhs_page import comment_rows, note_row, search_rows

ACTIVE = {"queued", "running", "stopping"}
# Seconds between page actions (scroll / expand) and between steps when a job
# sets no interval. Close to a reader's pace; the per-action floor is 1.5 s in
# research-executor.ts. Not a platform-approved rate.
DEFAULT_INTERVAL_S = 3
# XHS web pages load 10 first-level comments / 10 replies / 20 search cards per
# request; step budgets are derived from these page sizes, plus slack for the
# page's own first load and an end-of-list probe.
COMMENTS_PER_PAGE = 10
SEARCH_NOTES_PER_PAGE = 20
STEP_SLACK_REQUESTS = 2
PACING_SETTING = "xhs-page-pacing"
NOTE_ID = re.compile(r"/(?:explore|discovery/item)/([a-fA-F0-9]{24})")


class Service:
    def __init__(self, root: Path, page_bridge):
        self.root = root.resolve()
        self.page_bridge = page_bridge
        self.directory = self.root / "data" / "research"
        self.store = Store(self.directory)
        self.queue = asyncio.Queue()
        self.worker = None
        self.current = None
        self.operation = None
        self.instance_lock = None
        self.closing = False
        # 可选：研究内容 → 推荐候选池的搬运回调（由 api.app 注入）。
        # None 时研究模块保持完全独立，和旧行为一致。
        self.candidate_sink = None

    def run_dir(self, job: dict) -> Path:
        imported = job["config"].get("import_relative_path")
        if imported:
            directory = (self.root / "data" / "mediacrawler" / "runs" / imported).resolve()
            if not directory.is_relative_to((self.root / "data" / "mediacrawler" / "runs").resolve()):
                raise ValueError("导入路径不在采集目录")
            return directory
        return self.directory / "runs" / job["id"]

    async def start(self):
        # OS lock is released even on a crash; do not run standalone and full OBC workers together.
        import msvcrt
        self.instance_lock = open(self.directory / "service.lock", "a+b")
        self.instance_lock.write(b"0")
        self.instance_lock.flush()
        self.instance_lock.seek(0)
        try:
            msvcrt.locking(self.instance_lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.instance_lock.close()
            self.instance_lock = None
            raise RuntimeError("已有研究工作台使用此数据目录；请勿重复启动") from None
        for public in self.store.jobs():
            job = self.store.job(public["id"], private=True)
            if job["state"] in ACTIVE:
                if job["kind"] != "analyze":
                    self.store.ingest(job["id"], self.run_dir(job))
                self.store.update(job["id"], state="interrupted", pid=None,
                                  message="上次服务已中断；保留已采数据，不自动重跑")
        await self.import_existing()
        # Older workbench versions replaced source URLs with unusable bare IDs.
        # Restore only their URL fields from local MC files, without recollecting.
        for job in self.store.jobs():
            if job["kind"] != "analyze":
                self.store.restore_source_links(job["id"], self.run_dir(job))
        self.worker = asyncio.create_task(self.loop())

    async def close(self):
        self.closing = True
        if self.current:
            await self.cancel(self.current)
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        if self.instance_lock:
            self.instance_lock.close()

    async def import_existing(self) -> list[str]:
        imported = []
        directory = self.root / "data" / "mediacrawler" / "runs"
        if not directory.exists():
            return imported
        for run in sorted(directory.iterdir()):
            if not (run / "xhs" / "jsonl").is_dir():
                continue
            job_id = uuid.uuid5(uuid.NAMESPACE_URL, f"mediacrawler:{run.name}").hex
            if self.store.job(job_id):
                self.store.ingest(job_id, run)
                continue
            summary_file = run / "summary.json"
            summary = json.loads(summary_file.read_text(encoding="utf-8-sig")) if summary_file.exists() else {}
            self.store.create(job_id, "import", f"已有样本 · {summary.get('keyword', run.name)}",
                              {"import_relative_path": run.name, "topic": summary.get("keyword", "")}, "imported")
            self.store.ingest(job_id, run)
            self.store.update(job_id, coverage={"status": "bounded_sample", "exact_tag_filter": False,
                                               "source": "existing MediaCrawler JSONL", "complete": False},
                              message="已有样本已导入；历史采集范围不作全量保证")
            imported.append(job_id)
        return imported

    def submit(self, kind: str, title: str, config: dict) -> dict:
        if sum(job["state"] in ACTIVE for job in self.store.jobs()) >= 8:
            raise ValueError("队列已满，请先完成或停止已有任务")
        job_id = uuid.uuid4().hex
        self.store.create(job_id, kind, title, config)
        self.store.event(job_id, "任务已排队；同一时间仅执行一个任务")
        self.queue.put_nowait(job_id)
        return self.store.job(job_id)

    async def cancel(self, job_id: str):
        job = self.store.job(job_id, private=True)
        if not job:
            raise ValueError("任务不存在")
        if job["state"] not in ACTIVE:
            return
        if job_id == self.current:
            self.store.update(job_id, state="stopping", message="正在停止；已保存的数据不会删除")
            if self.operation:
                self.operation.cancel()
                await asyncio.gather(self.operation, return_exceptions=True)
            self.store.update(job_id, state="cancelled", message="任务已停止；已采数据可查看和导出")
        else:
            self.store.update(job_id, state="cancelled", message="已取消排队")

    async def loop(self):
        while True:
            job_id = await self.queue.get()
            if self.store.job(job_id)["state"] != "queued":
                continue
            self.current = job_id
            self.store.update(job_id, state="running", message="任务开始执行")
            job = self.store.job(job_id, private=True)
            self.operation = asyncio.create_task(analyze(self.store, job) if job["kind"] == "analyze" else self.crawl(job))
            try:
                await self.operation
            except asyncio.CancelledError:
                self.store.update(job_id, state="cancelled", message="任务已停止；已采数据可查看和导出")
            except Exception as exc:
                # Do not expose signed URLs, provider exception bodies or credentials.
                safe = str(exc) if type(exc) is ValueError else f"任务失败（{type(exc).__name__}），请检查模型或采集设置"
                self.store.event(job_id, safe)
                self.store.update(job_id, state="failed", message=safe)
            finally:
                if job["kind"] != "analyze":
                    try:
                        self.store.ingest(job_id, self.run_dir(job))
                    except Exception:
                        self.store.update(job_id, state="partial", message="采集文件未能完整入库；保留原文件，请检查数据格式")
                self.store.update(job_id, pid=None)
                self.current = self.operation = None
            if self.closing:
                return

    async def run_step(self, job: dict, step: dict) -> dict:
        """One page step, after the cooldown persisted across jobs and restarts."""
        interval = step["action_wait_ms"] / 1000
        last = float(self.store.setting(PACING_SETTING).get("last_step_at") or 0)
        wait = last + interval - time.time()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            return await self.page_bridge.run(step)
        finally:
            self.store.set_setting(PACING_SETTING, {"last_step_at": time.time()})

    async def crawl(self, job: dict):
        config = job["config"]
        discovery = job["kind"] == "discover"
        topic = config.get("topic", "")
        directory = self.run_dir(job)
        jsonl = directory / "xhs" / "jsonl"
        jsonl.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d")
        contents_file = jsonl / f"{'search' if discovery else 'detail'}_contents_{stamp}.jsonl"
        comments_file = jsonl / f"detail_comments_{stamp}.jsonl"
        progress_file = directory / "progress.jsonl"
        progress: list[dict] = []

        def record(event: str, **fields):
            item = {"event": event, **fields}
            progress.append(item)
            with progress_file.open("a", encoding="utf-8") as file:
                file.write(json.dumps(item, ensure_ascii=False) + "\n")

        def write(file: Path, rows: list[dict]):
            with file.open("a", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")

        interval = config.get("interval")
        wait_ms = int((DEFAULT_INTERVAL_S if interval is None else interval) * 1000)
        budget = config.get("max_requests")
        used = 0
        stop = None
        failure = ""
        max_notes = int(config.get("max_notes", len(config.get("urls", []))))
        max_comments = int(config.get("max_comments", 10))
        include_replies = bool(config.get("include_replies")) and not discovery
        record("scope", mode="search" if discovery else "detail", max_notes=max_notes,
               max_comments=max_comments, include_replies=include_replies, action_wait_ms=wait_ms,
               max_requests=budget, transport="extension_page")
        self.store.event(job["id"], f"{'发现内容' if discovery else '采集评论'}；系统会打开工作区小红书窗口，"
                                    f"插件在页面内翻页，动作间隔 {wait_ms / 1000:g} 秒，请让弹出的窗口留在前台")

        def step_budget(natural: int) -> int:
            return natural if budget is None else min(natural, int(budget) - used)

        def outcome(result: dict) -> str | None:
            status = result.get("status")
            if status in {"login_required", "platform_restricted", "request_cap_reached"}:
                return status
            if status == "error":
                return "account_busy" if result.get("reason") == "browser_busy" else "step_failed"
            return None

        if discovery:
            natural = math.ceil(max_notes / SEARCH_NOTES_PER_PAGE) + STEP_SLACK_REQUESTS
            result = await self.run_step(job, {"kind": "search", "keyword": topic, "max_notes": max_notes,
                                               "action_wait_ms": wait_ms, "max_requests": step_budget(natural)})
            used += int(result.get("requests") or 0)
            write(contents_file, search_rows(result.get("responses") or [], keyword=topic, limit=max_notes))
            self.store.ingest(job["id"], directory)
            stop = outcome(result)
            failure = str(result.get("reason") or "")
        else:
            urls = config["urls"]
            for index, url in enumerate(urls):
                match = NOTE_ID.search(url)
                note_id = match[1] if match else ""
                natural = math.ceil(max_comments / COMMENTS_PER_PAGE) + STEP_SLACK_REQUESTS
                if include_replies:
                    natural += max_comments
                remaining = step_budget(natural)
                if remaining <= 0:
                    stop = "request_cap_reached"
                    break
                self.store.event(job["id"], f"正在打开第 {index + 1}/{len(urls)} 篇笔记页面")
                result = await self.run_step(job, {
                    "kind": "note", "url": url, "note_id": note_id, "max_comments": max_comments,
                    "include_replies": include_replies, "action_wait_ms": wait_ms, "max_requests": remaining,
                })
                used += int(result.get("requests") or 0)
                note = result.get("note")
                row = note_row(note, url=url, keyword=topic) if isinstance(note, dict) else None
                if row is None:
                    record("note_skipped", content_id=note_id, reason=str(result.get("status") or ""))
                else:
                    write(contents_file, [{**row, "note_id": note_id or row["note_id"]}])
                    rows, summary = comment_rows(result.get("responses") or [], note_id=row["note_id"],
                                                 max_comments=max_comments, include_replies=include_replies)
                    write(comments_file, rows)
                    for root in summary["reply_threads"]:
                        record("replies_finished", content_id=row["note_id"], root_comment_id=root)
                    if result.get("status") == "ok":
                        record("comments_finished", content_id=row["note_id"],
                               exhausted=summary["list_ended"], truncated=summary["truncated"],
                               top_level=summary["top_level"])
                self.store.ingest(job["id"], directory)
                stop = outcome(result)
                failure = str(result.get("reason") or "")
                if stop:
                    break
        if stop:
            record(stop, reason=failure)
        code = 0 if stop is None else 1
        coverage = {"status": "bounded_sample", "exact_tag_filter": False, "complete": False,
                    "transport": "extension_page", "page_requests": used,
                    "scope": next((p for p in progress if p.get("event") == "scope"), {}),
                    "stop_reason": stop, "per_note": [p for p in progress if p.get("event") == "comments_finished"],
                    "reply_threads": [p for p in progress if p.get("event") == "replies_finished"],
                    "skipped_notes": [p for p in progress if p.get("event") == "note_skipped"]}
        saved_ids = {item["content_id"] for item in self.store.records(job["id"], "contents")}
        finished_ids = {item["content_id"] for item in coverage["per_note"]}
        coverage["missing_comment_completion_ids"] = sorted(saved_ids - finished_ids) if not discovery else []
        self.store.update(job["id"], coverage=coverage)
        # Final file validation: a truncated writer is visible as a partial dataset, not silently "success".
        invalid = 0
        for file in jsonl.glob("*.jsonl"):
            for line in file.read_text(encoding="utf-8-sig").splitlines():
                try:
                    json.loads(line)
                except json.JSONDecodeError:
                    invalid += 1
        records = self.store.job(job["id"])["counts"]
        has_data = bool(records.get("contents"))
        if code != 0 or invalid:
            events = {p.get("event") for p in progress}
            reason = ("浏览器里另有插件任务正在使用小红书标签页，请稍后再试" if "account_busy" in events else
                      "请到设置 → 平台源 → 小红书检查 OpenBiliClaw 插件和登录状态" if "login_required" in events else
                      "小红书限制了访问（繁忙、验证码或 IP/账号风控）；已停止，请稍后再试或检查登录状态"
                      if "platform_restricted" in events else
                      "已达到设置的请求上限；可调高上限后再采，或稍后继续" if "request_cap_reached" in events else
                      "插件页面执行失败或超时；请确认浏览器开着、插件已更新且小红书页面能正常打开")
            self.store.update(job["id"], state="partial" if has_data else "failed",
                              message=f"{reason}。已保存的数据仍可导出" + (f"；{invalid} 行文件不完整" if invalid else ""))
        elif not has_data:
            self.store.update(job["id"], state="partial", message="未取得可用内容；不视为成功采集")
        elif coverage["skipped_notes"] or coverage["missing_comment_completion_ids"] or (not discovery and len(saved_ids) != len(config["urls"])):
            self.store.update(job["id"], state="partial", message="部分内容不可访问或缺少评论完成记录；请查看数据范围，已得数据可导出")
        else:
            self.store.update(job["id"], state="completed", message="本次范围采集完成；不代表平台全部评论")
        # 一条流水线：发现阶段的元数据直接进推荐候选池（不搬评论，评论留在研究库，
        # 详情展开时按 content_id 回查）。桥接失败不改变本次采集的成功/失败。
        if discovery and records.get("contents") and self.candidate_sink is not None:
            try:
                self.candidate_sink(config.get("topic", ""), self.store.records(job["id"], "contents"), job["id"])
            except Exception:
                self.store.event(job["id"], "内容已保存，但同步到推荐流失败；可在研究数据中查看")


