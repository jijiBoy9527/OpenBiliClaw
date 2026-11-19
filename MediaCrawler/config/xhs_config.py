# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/config/xhs_config.py
# GitHub: https://github.com/NanmiCoder
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1
#

# 声明：本代码仅供学习和研究目的使用。使用者应遵守以下原则：
# 1. 不得用于任何商业用途。
# 2. 使用时应遵守目标平台的使用条款和robots.txt规则。
# 3. 不得进行大规模爬取或对平台造成运营干扰。
# 4. 应合理控制请求频率，避免给目标平台带来不必要的负担。
# 5. 不得用于任何非法或不当的用途。
#
# 详细许可条款请参阅项目根目录下的LICENSE文件。
# 使用本代码即表示您同意遵守上述原则和LICENSE中的所有条款。


import os

# Xiaohongshu platform configuration

# OpenBiliClaw supplies a one-shot local session over stdin; OpenCLI is retained for legacy commands.
# Both HTTP session modes keep crawling/storage in MediaCrawler.
# Other platforms and the original Playwright mode are unchanged.
XHS_BROWSER_BACKEND = os.getenv("XHS_BROWSER_BACKEND", "playwright")
XHS_HTTP_SESSION_MODE = XHS_BROWSER_BACKEND in {"opencli", "openbiliclaw"}
OPENCLI_NODE_BINARY = os.getenv("OPENCLI_NODE_BINARY", "node")
XHS_OPENCLI_REQUEST_INTERVAL = int(os.getenv("XHS_OPENCLI_REQUEST_INTERVAL", "60"))
if XHS_OPENCLI_REQUEST_INTERVAL < 10 or XHS_OPENCLI_REQUEST_INTERVAL > 120:
    raise ValueError("opencli HTTP 请求间隔必须在 10 至 120 秒之间")
XHS_OPENCLI_STATE_PATH = os.getenv("XHS_OPENCLI_STATE_PATH", "")
# Per process, including login check and HTML requests. Callers may lower it
# (the research workbench uses 15 for a single browsing session); 40 is the
# legacy ceiling, not a recommendation.
XHS_OPENCLI_MAX_REQUESTS = int(os.getenv("XHS_OPENCLI_MAX_REQUESTS", "40"))

# Sorting method, the specific enumeration value is in media_platform/xhs/field.py
SORT_TYPE = "popularity_descending"

# Specify the note URL list, which must carry the xsec_token parameter
XHS_SPECIFIED_NOTE_URL_LIST = [
    "https://www.xiaohongshu.com/explore/6aa3d827000000002802c5c8?xsec_token=YBIq8sY-0_K3BACQ7z57J9xJcdflrd8BAf5_zBeJtFMOQ=&xsec_source=pc_creatormng"
    # ........................
]

# Specify the creator URL list, which needs to carry xsec_token and xsec_source parameters.

XHS_CREATOR_ID_LIST = [
    "https://www.xiaohongshu.com/user/profile/5f58bd990000000001003753?xsec_token=ABYVg1evluJZZzpMX-VWzchxQ1qSNVW3r-jOEnKqMcgZw=&xsec_source=pc_search"
    # ........................
]
