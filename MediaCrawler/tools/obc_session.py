# Part of MediaCrawler. Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1.
"""Receive the explicitly requested OpenBiliClaw session over private stdin."""

import asyncio
import json
import sys

from tools.research_progress import report


async def read_obc_cookies() -> list[dict]:
    raw = await asyncio.to_thread(sys.stdin.buffer.read, 128001)
    try:
        if len(raw) > 128000:
            raise ValueError
        cookies = json.loads(raw)
        if not isinstance(cookies, list) or any(
            not isinstance(cookie, dict)
            or not isinstance(cookie.get("name"), str)
            or not isinstance(cookie.get("value"), str)
            for cookie in cookies
        ):
            raise ValueError
        values = {cookie["name"]: cookie["value"] for cookie in cookies}
        if not values.get("web_session") or not values.get("a1"):
            raise ValueError
        return cookies
    except (ValueError, UnicodeDecodeError):
        report("login_required")
        raise RuntimeError("未收到完整的小红书登录态；请在平台源设置连接 OpenBiliClaw 插件。") from None
