# Copyright (c) 2025 relakkes@gmail.com
# Part of MediaCrawler. Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1.
"""Optional structured progress, deliberately excluding session and signed links."""

import json
import os
from pathlib import Path


def report(event: str, **fields) -> None:
    destination = os.getenv("XHS_RESEARCH_PROGRESS")
    if destination:
        path = Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
