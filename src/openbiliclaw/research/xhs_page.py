"""Turn XHS page responses captured by the extension into research JSONL rows.

Rows keep the MediaCrawler JSONL field names the store already ingests
(``note_id``, ``liked_count``, ``parent_comment_id`` ...), so existing
datasets, imports, exports and the coverage manifest stay one format.
Unknown values stay empty; nothing is synthesized from bare IDs.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote


def _record(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _pick(record: dict, *keys: str) -> Any:
    """SSR state uses camelCase, page APIs use snake_case; accept either."""
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return value
    return None


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _data(response: dict) -> dict:
    return _record(_record(response.get("payload")).get("data"))


def _image_urls(note: dict) -> list[str]:
    urls = []
    for image in note.get("imageList") or note.get("image_list") or []:
        image = _record(image)
        url = _pick(image, "urlDefault", "url_default", "url")
        if not url:
            info = [_record(item) for item in image.get("infoList") or image.get("info_list") or []]
            url = next((item.get("url") for item in info if item.get("url")), None)
        if url:
            urls.append(str(url))
    if not urls:
        cover = _record(note.get("cover"))
        url = _pick(cover, "urlDefault", "url_default", "url")
        if url:
            urls.append(str(url))
    return urls


def note_row(note: dict, *, url: str, keyword: str) -> dict | None:
    """One note (SSR detail or search card) → a contents row."""
    note_id = _text(_pick(note, "noteId", "note_id", "id"))
    if not note_id:
        return None
    user = _record(note.get("user"))
    interact = _record(_pick(note, "interactInfo", "interact_info"))
    tags = [
        _text(_record(tag).get("name")) for tag in note.get("tagList") or note.get("tag_list") or []
    ]
    published = _pick(note, "time")
    return {
        "note_id": note_id,
        "type": _pick(note, "type"),
        "title": _text(_pick(note, "title", "displayTitle", "display_title")),
        "desc": _text(_pick(note, "desc")),
        "time": published if isinstance(published, int) else None,
        "nickname": _text(_pick(user, "nickname", "nickName", "nick_name")),
        "liked_count": _pick(interact, "likedCount", "liked_count"),
        "collected_count": _pick(interact, "collectedCount", "collected_count"),
        "comment_count": _pick(interact, "commentCount", "comment_count"),
        "share_count": _pick(interact, "shareCount", "share_count", "shared_count"),
        "image_list": ",".join(_image_urls(note)),
        "tag_list": ",".join(tag for tag in tags if tag),
        "note_url": url,
        "source_keyword": keyword,
        "last_modify_ts": int(time.time() * 1000),
    }


def search_rows(responses: list[dict], *, keyword: str, limit: int) -> list[dict]:
    rows, seen = [], set()
    for response in responses:
        if response.get("endpoint") != "search":
            continue
        for item in _data(response).get("items") or []:
            item = _record(item)
            note_id = _text(item.get("id"))
            token = _text(item.get("xsec_token"))
            if (
                item.get("model_type", "note") != "note"
                or not note_id
                or not token
                or note_id in seen
            ):
                continue
            url = (
                f"https://www.xiaohongshu.com/explore/{note_id}"
                f"?xsec_token={quote(token, safe='')}&xsec_source=pc_search"
            )
            row = note_row(
                {**_record(item.get("note_card")), "id": note_id}, url=url, keyword=keyword
            )
            if row:
                seen.add(note_id)
                rows.append(row)
            if len(rows) >= limit:
                return rows
    return rows


def _comment_row(comment: dict, *, note_id: str, parent: str, root: str) -> dict | None:
    comment_id = _text(comment.get("id"))
    if not comment_id:
        return None
    return {
        "comment_id": comment_id,
        "note_id": _text(comment.get("note_id")) or note_id,
        "content": _text(comment.get("content")),
        "create_time": comment.get("create_time"),
        "like_count": comment.get("like_count"),
        "sub_comment_count": comment.get("sub_comment_count"),
        "parent_comment_id": parent,
        "root_comment_id": root,
        "nickname": _text(_record(comment.get("user_info")).get("nickname")),
        "last_modify_ts": int(time.time() * 1000),
    }


def comment_rows(
    responses: list[dict], *, note_id: str, max_comments: int, include_replies: bool
) -> tuple[list[dict], dict]:
    """Top-level comments (first ``max_comments``) plus replies under them.

    Returns rows and a summary: whether the first-level list ended, and which
    reply threads were loaded.
    """
    rows: list[dict] = []
    kept_roots: list[str] = []
    seen: set[str] = set()
    ended = False

    def add(row: dict | None) -> None:
        if row and row["comment_id"] not in seen:
            seen.add(row["comment_id"])
            rows.append(row)

    for response in responses:
        if response.get("endpoint") != "comments":
            continue
        data = _data(response)
        if data.get("has_more") is False:
            ended = True
        for comment in data.get("comments") or []:
            comment = _record(comment)
            comment_id = _text(comment.get("id"))
            if not comment_id or comment_id in seen or len(kept_roots) >= max_comments:
                continue
            kept_roots.append(comment_id)
            add(_comment_row(comment, note_id=note_id, parent="", root=comment_id))
            if include_replies:
                for reply in comment.get("sub_comments") or []:
                    reply = _record(reply)
                    target = _text(_record(reply.get("target_comment")).get("id")) or comment_id
                    add(_comment_row(reply, note_id=note_id, parent=target, root=comment_id))
    roots = set(kept_roots)
    threads: set[str] = set()
    if include_replies:
        for response in responses:
            root = _text(response.get("root_comment_id"))
            if response.get("endpoint") != "replies" or root not in roots:
                continue
            threads.add(root)
            for reply in _data(response).get("comments") or []:
                reply = _record(reply)
                target = _text(_record(reply.get("target_comment")).get("id")) or root
                add(_comment_row(reply, note_id=note_id, parent=target, root=root))
    truncated = len(kept_roots) >= max_comments and not ended
    return rows, {
        "top_level": len(kept_roots),
        "list_ended": ended,
        "truncated": truncated,
        "reply_threads": sorted(threads),
    }
