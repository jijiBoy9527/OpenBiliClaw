"""Loopback-only research API integrated with the OpenBiliClaw desktop app."""

from __future__ import annotations

import os
import random
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from .analysis import public_settings, save_settings
from .browser import PlatformLoginBrowser
from .export import bundle
from .links import validate_link
from .service import ACTIVE, Service
from .session import XhsSessionBridge


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Discover(Input):
    topic: str = Field(min_length=1, max_length=100)
    max_notes: int = Field(default=5, ge=1, le=20)
    # 省略 = 每次任务随机 45–75 秒，避免固定节奏成为可识别的机器模式。
    interval: int | None = Field(default=None, ge=10, le=120)


class Collect(Input):
    topic: str = Field(default="选定内容研究", min_length=1, max_length=100)
    source_dataset_id: str | None = None
    content_ids: list[str] = Field(default_factory=list, max_length=10)
    urls: list[str] = Field(default_factory=list, max_length=10)
    max_comments: int = Field(default=20, ge=1, le=100)
    include_replies: bool = True
    interval: int | None = Field(default=None, ge=10, le=120)


class Analyze(Input):
    dataset_id: str
    goal: str = Field(default="提炼问题、需求和分歧", min_length=1, max_length=500)
    consent: bool


class FeedDiscover(Input):
    topic: str = Field(min_length=1, max_length=100)
    max_notes: int = Field(default=20, ge=1, le=40)


class FeedComments(Input):
    content_id: str = Field(default="", max_length=64)
    url: str = Field(default="", max_length=2000)


class FeedSummarize(Input):
    content_id: str = Field(min_length=1, max_length=64)


class FeedPurge(Input):
    topic: str = Field(default="", max_length=100)


class ModelSettings(Input):
    base_url: str = Field(min_length=1, max_length=1000)
    model: str = Field(min_length=1, max_length=150)
    api_key: str = Field(default="", max_length=2000)
    clear_key: bool = False


class SessionCookie(Input):
    name: str = Field(min_length=1, max_length=256, pattern=r"^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$")
    value: str = Field(max_length=16000, pattern=r"^[^\r\n;]*$")


class SessionReply(Input):
    request_id: str = Field(min_length=40, max_length=64)
    cookies: list[SessionCookie] = Field(max_length=100)


class ResearchRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handle(request: Request):
            try:
                response = await original(request)
            except ValueError as exc:
                if type(exc) is not ValueError:
                    raise
                raise HTTPException(422, str(exc)) from None
            response.headers["Cache-Control"] = "no-store"
            return response

        return handle


async def local_request(request: Request):
    peer = request.client.host if request.client else ""
    hostname = request.url.hostname
    if peer not in {"127.0.0.1", "::1"} or hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "研究工作台仅允许本机访问")
    from openbiliclaw.auth_core import is_extension_origin
    session_reply = request.url.path == "/api/research/session" and request.method == "POST"
    if session_reply and not is_extension_origin(request.headers.get("origin")):
        raise HTTPException(403, "仅接受本机浏览器插件的登录态响应")
    if not session_reply and request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "不接受跨站请求")
    origin = request.headers.get("origin")
    if not session_reply and origin and origin != f"{request.url.scheme}://{request.url.netloc}":
        raise HTTPException(403, "请求来源不匹配")
    if not session_reply and request.method not in {"GET", "HEAD"} and request.headers.get("x-research-request") != "1":
        raise HTTPException(403, "缺少工作台请求标识")
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > 128000):
        raise HTTPException(413, "请求过大")


def install(app: FastAPI, root: Path, get_event_hub):
    async def publish(event: dict) -> bool:
        return await get_event_hub().publish(event)

    session_bridge = XhsSessionBridge(publish)
    service = Service(root, session_bridge)
    # 一条流水线：把发现阶段的笔记推进推荐候选池。推荐运行时不可用时，
    # 研究模块保持独立（与改造前一致），不阻塞采集。
    runtime_ctx = getattr(app.state, "runtime_context", None)
    database = getattr(runtime_ctx, "database", None)
    if database is not None:
        from .bridge import push_research_contents

        def _push_to_pool(topic: str, contents, dataset_id: str) -> int:
            return push_research_contents(
                database, topic=topic, contents=contents, dataset_id=dataset_id
            )

        service.candidate_sink = _push_to_pool
    login_browser = PlatformLoginBrowser(root)

    @asynccontextmanager
    async def lifespan(_app):
        await service.start()
        try:
            yield
        finally:
            await service.close()

    router = APIRouter(prefix="/api/research", dependencies=[Depends(local_request)], lifespan=lifespan,
                       route_class=ResearchRoute)

    def required(job_id: str, private=False):
        job = service.store.job(job_id, private=private)
        if job is None:
            raise HTTPException(404, "任务或数据集不存在")
        return job

    @router.get("/status")
    def status():
        return {"application": "openbiliclaw-research", "ui": "openbiliclaw-desktop", "workspace": str(service.root),
                "pid": os.getpid(), "crawler_installed": (service.root / "MediaCrawler/.venv/Scripts/python.exe").exists(),
                "model": public_settings(service.store), "platform": "xhs", "local_only": True,
                "login_provider": "openbiliclaw-extension"}

    @router.post("/session")
    async def session_reply(data: SessionReply):
        accepted = session_bridge.receive(data.request_id, [cookie.model_dump() for cookie in data.cookies])
        if not accepted:
            raise HTTPException(409, "登录态请求已失效或已处理；未保存 Cookie")
        return {"accepted": True}

    @router.get("/jobs")
    def jobs():
        return {"items": service.store.jobs()}

    @router.get("/jobs/{job_id}")
    def job(job_id: str):
        return required(job_id)

    @router.get("/jobs/{job_id}/events")
    def events(job_id: str):
        required(job_id)
        with service.store.connect() as db:
            return {"items": [dict(row) for row in db.execute(
                "SELECT time,message FROM events WHERE job_id=? ORDER BY seq DESC LIMIT 100", (job_id,))]}

    @router.get("/jobs/{job_id}/records")
    def records(job_id: str, kind: Literal["contents", "comments", "findings"] = "contents",
                q: str = Query("", max_length=200), content_id: str = "",
                offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
        item = required(job_id)
        source_id = item["config"]["dataset_id"] if item["kind"] == "analyze" and kind != "findings" else job_id
        items = service.store.records(source_id, kind)
        if content_id:
            items = [record for record in items if record.get("content_id") == content_id]
        if q:
            items = [record for record in items if q.lower() in " ".join(
                str(record.get(key, "")) for key in ("title", "text", "summary", "category", "comment_id")).lower()]
        return {"items": items[offset:offset + limit], "total": len(items), "offset": offset, "limit": limit}

    @router.post("/discover")
    def discover(data: Discover):
        topic = data.topic.strip()
        if not topic or any(char in topic for char in ",，\r\n"):
            raise HTTPException(422, "每个发现任务请输入一个非空研究关键词，不要使用逗号分隔")
        payload = {**data.model_dump(), "topic": topic}
        payload["interval"] = data.interval or random.randint(45, 75)
        return service.submit("discover", f"发现 · {topic}", payload)

    @router.post("/collect")
    def collect(data: Collect):
        config = data.model_dump()
        urls = data.urls
        if data.source_dataset_id:
            if urls or not data.content_ids:
                raise HTTPException(422, "请选择候选笔记，或单独使用完整链接")
            source = required(data.source_dataset_id, private=True)
            if source["state"] in ACTIVE:
                raise HTTPException(409, "候选任务尚未结束，请等待完成或先停止")
            links = {item["content_id"]: item["url"] for item in service.store.records(source["id"], "contents")
                     if item.get("url")}
            if not set(data.content_ids) <= set(links):
                raise HTTPException(422, "部分选定内容缺少有效完整链接，请重新发现")
            urls = [links[key] for key in dict.fromkeys(data.content_ids)]
        elif data.content_ids or not urls:
            raise HTTPException(422, "请提供完整笔记链接，或从已有数据集选择内容")
        config["urls"] = list(dict.fromkeys(validate_link(url) for url in urls))
        config["max_notes"] = len(config["urls"])
        config["interval"] = data.interval or random.randint(45, 75)
        return service.submit("collect", f"评论采集 · {data.topic}", config)

    @router.post("/analyze")
    def start_analysis(data: Analyze):
        source = required(data.dataset_id)
        if source["state"] in ACTIVE:
            raise HTTPException(409, "请等待采集结束或先停止，再进行分析")
        if source["kind"] == "analyze" or not source["counts"].get("comments"):
            raise HTTPException(422, "请选择有评论的原始数据集")
        if not data.consent:
            raise HTTPException(422, "分析需要明确同意将评论发送至配置的模型服务")
        config = public_settings(service.store)
        if not config["model"] or not config["base_url"]:
            raise HTTPException(422, "请先保存模型设置")
        profile_id = uuid.uuid4().hex
        service.store.set_setting(f"model-profile:{profile_id}", service.store.setting("model"))
        return service.submit("analyze", data.goal, {**data.model_dump(), "model_profile_id": profile_id,
                                                     "model_target": config})

    @router.post("/jobs/{job_id}/stop")
    async def stop(job_id: str):
        required(job_id)
        await service.cancel(job_id)
        return {"ok": True}

    @router.post("/import")
    async def import_data():
        return {"imported": await service.import_existing()}

    @router.post("/browser")
    @router.post("/login")
    async def browser():
        await login_browser.open_xhs()
        return {"message": "已打开小红书登录窗口并自动加载 OpenBiliClaw 插件；请在窗口中登录，当前页面会自动检查连接"}

    @router.get("/model")
    def model():
        return public_settings(service.store)

    @router.put("/model")
    def model_save(data: ModelSettings):
        save_settings(service.store, data.model_dump())
        return public_settings(service.store)

    @router.get("/jobs/{job_id}/export")
    def export(job_id: str):
        source = required(job_id)
        if source["state"] in ACTIVE:
            raise HTTPException(409, "请等待任务结束或先停止，再导出稳定快照")
        return Response(bundle(service.store, job_id), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="research-{job_id[:8]}.zip"',
                                 "Cache-Control": "no-store"})

    app.include_router(router)

    # ── 首页内容流：唯一入口，不再有“研究数据”页 ──────────────────────────
    # 发现只拿元数据；评论必须由用户二次确认才采（默认绝不自动采评论）。
    feed_router = APIRouter(prefix="/api/feed", dependencies=[Depends(local_request)],
                            route_class=ResearchRoute)

    @feed_router.get("")
    def feed():
        from .feed import cached_summary, list_feed, topics_seen

        items = list_feed(service.store)
        for item in items:
            summary = cached_summary(service.store, item["content_id"])
            if summary["a"]:
                item["summary"] = summary["a"]
            item["summary_b"] = summary["b"]
        return {"items": items, "topics": topics_seen(service.store)}

    @feed_router.post("/summarize")
    async def feed_summarize(data: FeedSummarize):
        from .feed import find_content, generate_summary, list_comments

        content = find_content(service.store, data.content_id)
        if content is None:
            raise HTTPException(404, "内容不存在")
        comments = list_comments(service.store, data.content_id)
        if not comments:
            raise HTTPException(409, "还没有评论可总结；先点“采评论”")
        return await generate_summary(service.store, data.content_id, content, comments)

    @feed_router.delete("/items/{content_id}")
    def feed_delete(content_id: str):
        """删除一条主题内容：研究库记录 + 推荐候选/池（池内标记排除）。"""
        removed = service.store.delete_content(content_id)
        runtime_ctx = getattr(app.state, "runtime_context", None)
        database = getattr(runtime_ctx, "database", None)
        if database is not None:
            try:
                database._execute_write(  # noqa: SLF001 - 同仓内部写方法
                    "DELETE FROM discovery_candidates WHERE content_id=?",
                    (content_id,),
                )
                database._execute_write(  # noqa: SLF001
                    "UPDATE content_cache SET pool_status='purged_by_user' WHERE content_id=?",
                    (content_id,),
                )
            except Exception:
                pass
        return {"ok": True, "removed": removed}

    @feed_router.post("/purge")
    def feed_purge(data: FeedPurge):
        """批量清空主题内容；不给 topic 时清空全部主题内容。"""
        from .feed import list_feed

        items = list_feed(service.store, limit=1000)
        targets = items if not data.topic else [it for it in items if it["topic"] == data.topic]
        removed = 0
        for item in targets:
            removed += int(feed_delete(item["content_id"]).get("removed") or 0)
        return {"ok": True, "removed": removed, "count": len(targets)}

    @feed_router.post("/discover")
    def feed_discover(data: FeedDiscover):
        topic = data.topic.strip()
        if not topic or any(char in topic for char in ",，\r\n"):
            raise HTTPException(422, "请输入一个非空主题，不要使用逗号分隔")
        payload = {"topic": topic, "max_notes": data.max_notes, "interval": random.randint(45, 75)}
        return service.submit("discover", f"发现 · {topic}", payload)

    @feed_router.post("/comments")
    def feed_collect_comments(data: FeedComments):
        from .feed import content_id_from_url, find_content

        if data.content_id:
            content = find_content(service.store, data.content_id) or {}
            url = str(content.get("url") or data.url or "").strip()
            title = str(content.get("title") or "选定内容")[:100]
            content_id = data.content_id
        else:
            url = data.url.strip()
            title = "选定内容"
            content_id = content_id_from_url(url)
        if not url or not content_id:
            raise HTTPException(422, "需要完整的笔记链接（含 xsec_token）")
        # 同一篇已有排队/执行中的任务就直接复用，避免重复点击排出多个任务。
        for job in service.store.jobs():
            if job.get("kind") != "collect" or job.get("state") not in ACTIVE:
                continue
            if (job.get("config") or {}).get("content_id") == content_id:
                return job
        url = validate_link(url)
        config = {
            "topic": title[:100],
            "urls": [url],
            "content_id": content_id,
            "max_notes": 1,
            "max_comments": 20,
            "include_replies": True,
            "interval": random.randint(45, 75),
        }
        return service.submit("collect", f"采评论 · {title[:20]}", config)

    @feed_router.get("/comments/{content_id}")
    def feed_comments(content_id: str):
        from .feed import list_comments

        return {"items": list_comments(service.store, content_id)}

    app.include_router(feed_router)

    @app.get("/research", include_in_schema=False)
    @app.get("/research/", include_in_schema=False)
    def research_page():
        return RedirectResponse("/web/#research")

    app.state.research_service = service


def create_app() -> FastAPI:
    """Start the real desktop runtime; research is installed by api.app."""
    from openbiliclaw.api.app import create_app as create_desktop_app

    return create_desktop_app()
