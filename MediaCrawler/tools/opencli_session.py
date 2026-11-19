# Copyright (c) 2025 relakkes@gmail.com
# Part of MediaCrawler. Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1.
"""Read the user's existing XHS session without exporting cookies to disk."""

import asyncio
import json
from pathlib import Path
from typing import Dict, List

import config
from tools.research_progress import report


async def read_xhs_cookies(origin: str) -> List[Dict]:
    script = Path(__file__).with_suffix(".mjs")
    process = await asyncio.create_subprocess_exec(
        config.OPENCLI_NODE_BINARY,
        str(script),
        origin,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=45)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        report("login_required")
        raise RuntimeError("无法读取 opencli 登录态；请先启动守护进程、连接扩展，检查浏览器 profile。")
    try:
        cookies = json.loads(stdout)
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError("opencli 返回了无效的 Cookie 数据；未输出或保存原始响应。") from None
    if not isinstance(cookies, list) or any(
        not isinstance(cookie, dict)
        or not isinstance(cookie.get("name"), str)
        or not isinstance(cookie.get("value"), str)
        for cookie in cookies
    ):
        raise RuntimeError("opencli Cookie 响应不符合约定。")
    values = {cookie["name"]: cookie["value"] for cookie in cookies}
    if not values.get("web_session") or not values.get("a1"):
        report("login_required")
        raise RuntimeError("浏览器尚无完整的小红书登录态；请在已连接 opencli 的浏览器中手动登录后重跑。")
    return cookies
