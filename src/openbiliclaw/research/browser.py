"""The workspace-owned login window, with the one OpenBiliClaw extension."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path


class PlatformLoginBrowser:
    """Open a stable app-owned profile; never copy an account's cookies."""

    def __init__(self, root: Path):
        self.root = root
        self.lock = asyncio.Lock()

    async def open_xhs(self) -> None:
        async with self.lock:
            await asyncio.to_thread(self._launch)

    async def reopen_xhs(self) -> None:
        """Close the workspace window and open it again so the extension reloads.

        An already-open Chrome ignores a second launch, including a new backend
        port file, and its service worker may stay asleep.
        """
        async with self.lock:
            profile = self.root / "browser/openbiliclaw-profile"
            await asyncio.to_thread(self._close_profile, profile)
            await asyncio.sleep(1)
            await asyncio.to_thread(self._launch)

    def _close_profile(self, profile: Path) -> None:
        if sys.platform != "win32":
            return
        env = os.environ.copy()
        env["OBC_PROFILE"] = str(profile)
        subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
                "Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($env:OBC_PROFILE.ToLower()) } | "
                "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
            ],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=20,
        )

    def _launch(self) -> None:
        if sys.platform != "win32":
            raise ValueError("工作区一键登录目前仅支持本机 Windows")
        executable = self.root / "browser/chrome-win64/chrome.exe"
        extension = self.root / "browser/openbiliclaw-extension"
        if not executable.is_file() or not (extension / "manifest.json").is_file():
            raise ValueError("本机登录浏览器或 OpenBiliClaw 插件包缺失，请修复工作区安装")
        # Do not reuse the old OpenCLI profile: an already-open Chrome would
        # ignore the new extension flags and leave the user disconnected.
        # Home, settings and research always use this same app-owned profile.
        profile = self.root / "browser/openbiliclaw-profile"
        try:
            profile.mkdir(parents=True, exist_ok=True)
            recorded = self.root / "runtime" / "backend.json"
            if recorded.is_file():
                (extension / "backend.json").write_text(
                    recorded.read_text(encoding="utf-8"), encoding="utf-8"
                )
            subprocess.Popen(
                [
                    str(executable), f"--user-data-dir={profile}",
                    f"--load-extension={extension}", f"--disable-extensions-except={extension}",
                    f"--disk-cache-dir={self.root / '.cache/openbiliclaw-chrome'}",
                    "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
                    "https://www.xiaohongshu.com/explore",
                ],
                cwd=self.root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        except OSError:
            raise ValueError("登录窗口启动失败，请检查本机浏览器文件；没有读取或复制账号 Cookie") from None
