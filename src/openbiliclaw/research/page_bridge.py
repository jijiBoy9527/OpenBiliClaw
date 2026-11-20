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
    def __init__(self, publish: Callable[[dict], Awaitable[bool]], ensure_browser=None, extension_count=None):
        self.publish = publish
        self.ensure_browser = ensure_browser
        self.extension_count = extension_count
        self.pending: dict[str, asyncio.Future] = {}
        self.extension_ready = False

    async def run(self, step: dict) -> dict:
        if not self.extension_ready:
            await self._prepare_browser()
        try:
            result = await self._once(step)
        except ValueError:
            self.extension_ready = False
            await self._prepare_browser()
            result = await self._once(step)
        self.extension_ready = True
        return result

    async def _prepare_browser(self) -> None:
        """Use a connected extension, or reload the workspace window until one connects."""
        if self.extension_count is not None and self.extension_count() > 0:
            return
        if self.ensure_browser is not None:
            await self.ensure_browser()
        for _ in range(30):
            if self.extension_count is None or self.extension_count() > 0:
                return
            await asyncio.sleep(1)
        raise ValueError(
            "系统已重新打开工作区小红书窗口，但插件还没连上工作台。"
            "请看弹出的窗口；如果页面要求登录，登录即可"
        )

    async def _once(self, step: dict) -> dict:
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
                    "系统已打开工作区小红书窗口并载入插件，但插件还没连上。"
                    "请看弹出的窗口；如果页面要求登录，登录即可"
                )
            try:
                return await asyncio.wait_for(future, step_timeout(step))
            except TimeoutError:
                raise ValueError(
                    "系统已打开工作区小红书窗口，但插件没有在限定时间内交回页面结果。"
                    "请让弹出的窗口留在前台；如果页面要求登录，登录即可"
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
