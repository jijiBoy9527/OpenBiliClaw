"""One-shot, memory-only handoff from the existing platform extension."""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import Awaitable, Callable


class XhsSessionBridge:
    def __init__(self, publish: Callable[[dict], Awaitable[bool]]):
        self.publish = publish
        self.pending: dict[str, asyncio.Future] = {}

    async def request(self) -> bytes:
        request_id = secrets.token_urlsafe(32)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            delivered = await self.publish({
                "type": "xhs_research_session_requested", "request_id": request_id,
            })
            if delivered is False:
                raise ValueError("小红书插件未连接；请到设置 → 平台源 → 小红书连接 OpenBiliClaw 插件")
            try:
                cookies = await asyncio.wait_for(future, 20)
            except TimeoutError:
                raise ValueError("未收到小红书登录态；请连接更新后的 OpenBiliClaw 插件，后端地址设为 127.0.0.1:8766") from None
            if not cookies:
                raise ValueError("小红书尚未完整登录；请在安装 OpenBiliClaw 插件的同一浏览器登录小红书")
            return json.dumps(cookies, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        finally:
            self.pending.pop(request_id, None)

    def receive(self, request_id: str, cookies: list[dict]) -> bool:
        future = self.pending.get(request_id)
        if future is None or future.done():
            return False
        values = {cookie["name"]: cookie["value"] for cookie in cookies}
        future.set_result(cookies if values.get("web_session") and values.get("a1") else [])
        return True



