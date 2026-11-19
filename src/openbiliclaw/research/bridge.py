"""研究采集 → 推荐候选池的唯一搬运口（一条流水线）。

分工：
- MediaCrawler（research 模块）负责**抓**（笔记 + 评论），它是唯一抓取手；
- 推荐引擎负责**排序 / 摘要 / 展示**，它不再自己抓小红书；
- 本模块只做数据搬运，把 research 采到的笔记转成推荐池的候选行。

设计约束：
- 只搬运，不做业务判断：去重交给 ``candidate_key``，时效/配额交给
  推荐池既有的入队策略；
- 失败不阻断采集：桥接异常只记日志，研究任务仍然完成、数据仍可导出；
- 可重复调用：``enqueue_discovery_candidates`` 对同 key 只刷新 ``last_seen_at``。
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Sequence

logger = logging.getLogger("openbiliclaw.research.bridge")

# research 来源在候选池里的策略标识；详情页据此回到研究库取评论原文。
RESEARCH_STRATEGY = "research"


def _coerce_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _published_iso(raw: Any) -> str:
    """把 MediaCrawler 的毫秒时间戳转成 ISO；解析不了就原样返回。"""
    if raw in (None, "", 0):
        return ""
    try:
        millis = int(raw)
    except (TypeError, ValueError):
        return str(raw)
    from datetime import datetime, timezone

    # 13 位是毫秒；10 位是秒。超出范围视为不可用，避免把脏数据写进排序。
    if millis > 10_000_000_000:
        millis //= 1000
    try:
        return datetime.fromtimestamp(millis, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return ""


def _content_to_item(content: dict[str, Any], topic: str) -> Any:
    """一条 research ``contents`` 记录 → ``DiscoveredContent``。"""
    from openbiliclaw.discovery.engine import DiscoveredContent

    content_id = str(content.get("content_id") or "").strip()
    platform = str(content.get("platform") or "xhs").strip().lower()
    if platform in {"xhs", "xiaohongshu"}:
        platform = "xiaohongshu"
    return DiscoveredContent(
        source_platform=platform,
        source_strategy=RESEARCH_STRATEGY,
        content_type="note" if platform == "xiaohongshu" else "video",
        content_id=content_id,
        bvid=content_id,
        content_url=str(content.get("url") or ""),
        title=str(content.get("title") or ""),
        body_text=str(content.get("text") or ""),
        author_name=str(content.get("author_name") or ""),
        cover_url=str(content.get("cover_url") or ""),
        like_count=_coerce_int(content.get("likes")),
        comment_count=_coerce_int(content.get("reported_comment_count")),
        tags=content.get("tags") or [],
        published_at=_published_iso(content.get("published_at_raw")),
    )


def research_contents_to_candidates(
    contents: Iterable[dict[str, Any]],
    *,
    topic: str = "",
    dataset_id: str = "",
) -> list[Any]:
    """把一批 research 内容转成候选池写入对象（跳过没有 ID 的行）。"""
    from openbiliclaw.discovery.candidate_pool import discovered_content_to_candidate_write

    writes: list[Any] = []
    for content in contents:
        if not isinstance(content, dict):
            continue
        if not str(content.get("content_id") or "").strip():
            continue
        try:
            item = _content_to_item(content, topic)
            write = discovered_content_to_candidate_write(
                item,
                source_context=topic,
                raw_payload={
                    # 详情页回到研究库取评论时用；不是上游原始行。
                    "research_dataset_id": dataset_id,
                    "research_topic": topic,
                },
            )
        except Exception:  # 单行坏数据不能拖垮整批
            logger.warning("research bridge: skip malformed content row", exc_info=True)
            continue
        writes.append(write)
    return writes


def push_research_contents(
    database: Any,
    *,
    topic: str,
    contents: Sequence[dict[str, Any]],
    dataset_id: str = "",
) -> int:
    """把研究采集结果推进推荐候选池，返回写入条数。

    只在 discover 类任务完成后调用；评论不在这里搬（评论留在研究库，
    详情展开时按 content_id 回查）。
    """
    if database is None:
        return 0
    writes = research_contents_to_candidates(contents, topic=topic, dataset_id=dataset_id)
    if not writes:
        return 0
    try:
        inserted = database.enqueue_discovery_candidates(writes)
    except Exception:
        # 桥接失败不能影响采集任务本身的成功/导出。
        logger.exception("research bridge: enqueue_discovery_candidates failed")
        return 0
    logger.info("research bridge: topic=%r pushed=%d", topic, inserted)
    return int(inserted or 0)
