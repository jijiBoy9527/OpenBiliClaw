"""Run research steps inside the user's own XHS page through the extension.

The backend never requests XHS and never holds the account session. Each step
(one search page, or one note's comments) is published on the runtime stream;
the extension opens that page in a task tab, scrolls / expands it like a
reader, and returns the responses the page itself requested. Results bind to
a random one-shot request ID; late, replayed or unknown results are refused.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

# Mirrors the extension's per-step timeout (xhs-research-runner.ts) plus a
# margin for tab creation and the result POST, so the extension times out first.
STEP_BASE_TIMEOUT_S = 90
STEP_PER_REQUEST_S = 15
STEP_MAX_TIMEOUT_S = 30 * 60
RESULT_MARGIN_S = 60


def step_timeout(step: dict) -> float:
    per_action = STEP_PER_REQUEST_S + step["action_wait_ms"] / 1000
    return (
        min(STEP_BASE_TIMEOUT_S + step["max_requests"] * per_action, STEP_MAX_TIMEOUT_S)
        + RESULT_MARGIN_S
    )


class XhsPageBridge:
    def __init__(self, publish: Callable[[dict], Awaitable[bool]]):
        self.publish = publish
        self.pending: dict[str, asyncio.Future] = {}

    async def run(self, step: dict) -> dict:
        request_id = secrets.token_urlsafe(32)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            delivered = await self.publish(
                {
                    "type": "xhs_research_task_requested",
                    "request_id": request_id,
                    "step": step,
                }
            )
            if delivered is False:
                raise ValueError(
                    "小红书插件未连接；请到设置 → 平台源 → 小红书连接 OpenBiliClaw 插件"
                )
            try:
                return await asyncio.wait_for(future, step_timeout(step))
            except TimeoutError:
                raise ValueError(
                    "插件未在限定时间内返回页面结果；请确认浏览器开着且插件已更新"
                ) from None
            except asyncio.CancelledError:
                # Stopped from the workbench: let the extension close the task tab now.
                await self.publish(
                    {"type": "xhs_research_task_cancelled", "request_id": request_id}
                )
                raise
        finally:
            self.pending.pop(request_id, None)

    def receive(self, request_id: str, result: dict) -> bool:
        future = self.pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(result)
        return True
