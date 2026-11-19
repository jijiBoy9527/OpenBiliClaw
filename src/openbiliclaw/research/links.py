"""Validate real XHS source links without removing their access parameters."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit


def validate_link(url: str, *, content_id: str | None = None) -> str:
    """Keep the complete source URL; a bare note ID is not a usable source link."""
    url = url.strip()
    if len(url) > 3000 or "," in url or any(ord(char) <= 32 or ord(char) == 127 for char in url):
        raise ValueError("笔记链接格式无效或过长")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise ValueError("笔记链接格式无效") from None
    if parsed.scheme != "https" or parsed.hostname not in {"www.xiaohongshu.com", "xiaohongshu.com"}:
        raise ValueError("请提供小红书网页版完整笔记链接，不支持短链接或其他域名")
    match = re.fullmatch(r"/(?:explore|discovery/item)/([a-fA-F0-9]{24})/?", parsed.path)
    if not match or parsed.username or parsed.password or port not in {None, 443}:
        raise ValueError("笔记链接格式无效")
    if content_id is not None and match[1].lower() != content_id.lower():
        raise ValueError("来源链接与笔记 ID 不匹配")
    token = parse_qs(parsed.query).get("xsec_token", [])
    # MediaCrawler's note_url template can stringify a missing token as "None".
    if len(token) != 1 or not token[0].strip() or token[0] == "None":
        raise ValueError("链接缺少有效 xsec_token；请重新发现，或复制浏览器中的完整笔记链接")
    return url
