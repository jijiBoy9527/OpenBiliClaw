"""Single local queue; external crawler remains isolated in its own environment."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from pathlib import Path

from .analysis import analyze
from .store import Store

ACTIVE = {"queued", "running", "stopping"}


class Service:
    def __init__(self, root: Path, session_bridge):
        self.root = root.resolve()
        self.session_bridge = session_bridge
        self.directory = self.root / "data" / "research"
        self.store = Store(self.directory)
        self.queue = asyncio.Queue()
        self.worker = None
        self.current = None
        self.operation = None
        self.process = None
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
                if job.get("pid"):
                    await self.stop_owned_process(job)
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
            if self.process and self.process.returncode is None:
                await self.stop_owned_process({**job, "pid": self.process.pid})
            if self.operation:
                self.operation.cancel()
                await asyncio.gather(self.operation, return_exceptions=True)
            self.store.update(job_id, state="cancelled", message="任务已停止；已采数据可查看和导出")
        else:
            self.store.update(job_id, state="cancelled", message="已取消排队")

    async def stop_owned_process(self, job: dict):
        pid = job["pid"]
        command = await asyncio.create_subprocess_exec(
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        stdout, _ = await command.communicate()
        line = stdout.decode("utf-8", errors="replace")
        # Both the launcher filename and this run UUID must match; never kill by name.
        if "mediacrawler.mjs" not in line or job["id"] not in line:
            if line.strip():
                raise ValueError("任务进程归属无法确认，未终止其他进程；请人工检查")
            return
        child = await asyncio.create_subprocess_exec(
            "taskkill.exe", "/PID", str(pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        await child.wait()
        if child.returncode:
            raise ValueError("未能停止采集进程，请检查本机进程状态")
        if self.process and self.process.pid == pid:
            await self.process.wait()

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
                self.current = self.operation = self.process = None
            if self.closing:
                return

    async def crawl(self, job: dict):
        config = job["config"]
        self.store.event(job["id"], "正在向统一的小红书插件读取本次登录态；不启动第二套浏览器")
        session = await self.session_bridge.request()
        directory = self.run_dir(job)
        directory.mkdir(parents=True, exist_ok=True)
        discovery = job["kind"] == "discover"
        args = [str(self.root / "runtime" / "node-v22.19.0-win-x64" / "node.exe"),
                str(self.root / "scripts" / "mediacrawler.mjs"),
                "--type", "search" if discovery else "detail",
                "--keywords", config.get("topic", ""),
                "--crawler_max_notes_count", str(config.get("max_notes", len(config.get("urls", [])))),
                "--max_comments_count_singlenotes", str(config.get("max_comments", 10)),
                "--get_comment", "no" if discovery else "yes",
                "--get_sub_comment", "yes" if config.get("include_replies") and not discovery else "no",
                "--get_media", "no", "--save_data_option", "jsonl", "--save_data_path", str(directory)]
        if not discovery:
            args += ["--specified_id", ",".join(config["urls"])]
        environment = {**os.environ, "XHS_BROWSER_BACKEND": "openbiliclaw",
                       "XHS_RESEARCH_PROGRESS": str(directory / "progress.jsonl")}
        # 间隔和请求上限只在任务显式指定时才覆盖；不指定就用 MediaCrawler 自身默认值
        # （2 秒间隔、不限请求数），不在这一层叠加额外限速。
        if config.get("interval") is not None:
            environment["XHS_OPENCLI_REQUEST_INTERVAL"] = str(config["interval"])
        if config.get("max_requests") is not None:
            environment["XHS_OPENCLI_MAX_REQUESTS"] = str(config["max_requests"])
        with (directory / "private-crawler.log").open("ab") as log:
            spawning = asyncio.create_task(asyncio.create_subprocess_exec(
                *args, cwd=self.root, env=environment, stdin=asyncio.subprocess.PIPE, stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ))
            try:
                self.process = await asyncio.shield(spawning)
            except asyncio.CancelledError:
                self.process = await spawning
                self.store.update(job["id"], pid=self.process.pid)
                await self.stop_owned_process({**job, "pid": self.process.pid})
                raise
            self.store.update(job["id"], pid=self.process.pid)
            try:
                self.process.stdin.write(session)
                await self.process.stdin.drain()
                self.process.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                await self.stop_owned_process({**job, "pid": self.process.pid})
                raise ValueError("采集进程未能接收登录态，已停止；请检查本机采集环境") from None
            finally:
                del session
            interval = config.get("interval")
            pace = f"HTTP 间隔 {interval} 秒" if interval is not None else "使用 MediaCrawler 默认节奏"
            self.store.event(job["id"], f"{'发现内容' if discovery else '采集评论'}；{pace}，请勿关闭工作台服务")
            while self.process.returncode is None:
                try:
                    await asyncio.wait_for(asyncio.shield(self.process.wait()), 2)
                except asyncio.TimeoutError:
                    self.store.ingest(job["id"], directory)
            code = self.process.returncode
        self.store.ingest(job["id"], directory)
        progress_file = directory / "progress.jsonl"
        progress = []
        if progress_file.exists():
            for line in progress_file.read_text(encoding="utf-8").splitlines():
                try:
                    progress.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        coverage = {"status": "bounded_sample", "exact_tag_filter": False, "complete": False,
                    "scope": next((p for p in progress if p.get("event") == "scope"), {}),
                    "request_exit_code": code, "per_note": [p for p in progress if p.get("event") == "comments_finished"],
                    "reply_threads": [p for p in progress if p.get("event") == "replies_finished"],
                    "skipped_notes": [p for p in progress if p.get("event") == "note_skipped"]}
        saved_ids = {item["content_id"] for item in self.store.records(job["id"], "contents")}
        finished_ids = {item["content_id"] for item in coverage["per_note"]}
        coverage["missing_comment_completion_ids"] = sorted(saved_ids - finished_ids) if not discovery else []
        self.store.update(job["id"], coverage=coverage)
        # Final file validation: a truncated writer is visible as a partial dataset, not silently "success".
        invalid = 0
        for file in (directory / "xhs" / "jsonl").glob("*.jsonl"):
            for line in file.read_text(encoding="utf-8-sig").splitlines():
                try:
                    json.loads(line)
                except json.JSONDecodeError:
                    invalid += 1
        records = self.store.job(job["id"])["counts"]
        has_data = bool(records.get("contents"))
        if code != 0 or invalid:
            events = {p.get("event") for p in progress}
            reason = ("已有其他采集任务占用账号" if "account_busy" in events else
                      "请到设置 → 平台源 → 小红书检查 OpenBiliClaw 插件和登录状态" if "login_required" in events else
                      "小红书限制了访问（繁忙、验证码或 IP/账号风控）；已停止，请稍后再试或检查登录状态"
                      if "platform_restricted" in events else
                      "已达到设置的请求上限；可调高上限后再采，或稍后继续" if "request_cap_reached" in events else
                      "网络失败或采集进程异常退出；请查看采集日志")
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


