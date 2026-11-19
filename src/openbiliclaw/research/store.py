"""Durable job state and versioned, deduplicated dataset snapshots."""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .links import validate_link

SCHEMA_VERSION = "research.dataset.v1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def count_value(value: Any) -> int | None:
    if value is None or value == "":
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(万|亿|[kKwW])?\+?", str(value).replace(",", ""))
    if not match:
        return None
    scale = {"万": 10000, "亿": 100000000, "w": 10000, "k": 1000}
    return int(float(match[1]) * scale.get((match[2] or "").lower(), 1))


def source_link(value: Any, content_id: str) -> str | None:
    """Missing/invalid links stay unknown, never synthesize an unsigned URL."""
    if not isinstance(value, str):
        return None
    try:
        return validate_link(value, content_id=content_id)
    except ValueError:
        return None


class Store:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "research.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
                    state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    config TEXT NOT NULL, message TEXT NOT NULL, pid INTEGER,
                    coverage TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS records (
                    dataset_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
                    record_id TEXT NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(dataset_id, kind, record_id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
                    time TEXT NOT NULL, message TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, job_id: str, kind: str, title: str, config: dict, state="queued"):
        with self.connect() as db:
            db.execute(
                "INSERT INTO jobs(id,kind,title,state,created_at,updated_at,config,message) "
                "VALUES(?,?,?,?,?,?,?,?)", (job_id, kind, title, state, now(), now(),
                                           encode(config), "等待执行"),
            )

    def update(self, job_id: str, **changes):
        allowed = {"state", "message", "pid", "coverage"}
        if not changes or not set(changes) <= allowed:
            raise ValueError("Invalid job update")
        values = {**changes, "updated_at": now()}
        if "coverage" in values:
            values["coverage"] = encode(values["coverage"])
        with self.connect() as db:
            db.execute("UPDATE jobs SET " + ",".join(f"{k}=?" for k in values) + " WHERE id=?",
                       (*values.values(), job_id))

    def event(self, job_id: str, message: str):
        with self.connect() as db:
            db.execute("INSERT INTO events(job_id,time,message) VALUES(?,?,?)",
                       (job_id, now(), message))
        self.update(job_id, message=message)

    def job(self, job_id: str, private=False) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                return None
            item = dict(row)
            item["config"] = json.loads(item["config"])
            item["coverage"] = json.loads(item["coverage"])
            item["counts"] = dict(db.execute(
                "SELECT kind,COUNT(*) FROM records WHERE dataset_id=? GROUP BY kind", (job_id,)
            ).fetchall())
        if not private:
            item["config"].pop("urls", None)  # Source URLs belong to content records, not job parameters.
            item.pop("pid", None)
        return item

    def jobs(self) -> list[dict]:
        with self.connect() as db:
            ids = [r[0] for r in db.execute("SELECT id FROM jobs ORDER BY created_at DESC")]
        return [self.job(job_id) for job_id in ids]

    def records(self, dataset_id: str, kind: str) -> list[dict]:
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute(
                "SELECT payload FROM records WHERE dataset_id=? AND kind=? ORDER BY record_id",
                (dataset_id, kind))]

    def save(self, dataset_id: str, kind: str, record_id: str, payload: dict):
        with self.connect() as db:
            db.execute("INSERT INTO records VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET payload=excluded.payload",
                       (dataset_id, kind, record_id, encode(payload)))

    def delete_content(self, content_id: str) -> int:
        """删除一条内容及其全部评论（跨数据集）。返回删除的记录数。"""
        target = str(content_id or "").strip()
        if not target:
            return 0
        with self.connect() as db:
            contents = db.execute(
                "DELETE FROM records WHERE kind='contents' AND json_extract(payload,'$.content_id')=?",
                (target,),
            ).rowcount
            comments = db.execute(
                "DELETE FROM records WHERE kind='comments' AND json_extract(payload,'$.content_id')=?",
                (target,),
            ).rowcount
        return int(contents or 0) + int(comments or 0)

    def setting(self, key: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else {}

    def set_setting(self, key: str, value: dict):
        with self.connect() as db:
            db.execute("INSERT INTO settings VALUES(?,?) ON CONFLICT DO UPDATE SET value=excluded.value",
                       (key, encode(value)))

    def ingest(self, dataset_id: str, run_dir: Path):
        """Only index known MC files; incomplete trailing lines wait until next refresh."""
        for path in sorted((run_dir / "xhs" / "jsonl").glob("*.jsonl")):
            kind = "contents" if "_contents_" in path.name else "comments" if "_comments_" in path.name else None
            if kind is None:
                continue
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue  # Revisited after the writer finishes; final import checked by runner.
                modified = raw.get("last_modify_ts")
                timestamp = datetime.fromtimestamp(modified / 1000, timezone.utc).isoformat() if modified else None
                if kind == "contents":
                    record_id = str(raw["note_id"])
                    # MediaCrawler 把图片 URL 存成逗号分隔字符串；第一张就是封面。
                    images = [part.strip() for part in str(raw.get("image_list") or "").split(",") if part.strip()]
                    payload = {
                        "schema_version": SCHEMA_VERSION, "platform": "xhs", "content_id": record_id,
                        "url": source_link(raw.get("note_url"), record_id),
                        "title": raw.get("title", ""), "text": raw.get("desc", ""),
                        "type": raw.get("type"), "tags": raw.get("tag_list", "").split(","),
                        "cover_url": images[0] if images else "",
                        "image_list": images,
                        "author_name": str(raw.get("nickname") or ""),
                        "published_at_raw": raw.get("time"), "source_keyword": raw.get("source_keyword", ""),
                        "likes": count_value(raw.get("liked_count")),
                        "favorite_count": count_value(raw.get("collected_count")),
                        "share_count": count_value(raw.get("share_count")),
                        "reported_comment_count": count_value(raw.get("comment_count")),
                        "collected_at": timestamp,
                        "video_transcribed": False,
                    }
                else:
                    record_id = str(raw["comment_id"])
                    parent = raw.get("parent_comment_id") or None
                    text = raw.get("content") or ""
                    payload = {
                        "schema_version": SCHEMA_VERSION, "platform": "xhs", "comment_id": record_id,
                        "content_id": str(raw["note_id"]), "parent_comment_id": parent,
                        "root_comment_id": raw.get("root_comment_id") or (record_id if not parent else None),
                        "is_reply": bool(parent or (raw.get("root_comment_id") and raw["root_comment_id"] != record_id)),
                        "nickname": str(raw.get("nickname") or ""),
                        "text": text, "cleaned_text": re.sub(r"[\u200b-\u200d\ufeff]", "", text).strip(),
                        "published_at_raw": raw.get("create_time"), "likes": count_value(raw.get("like_count")),
                        "reported_reply_count": count_value(raw.get("sub_comment_count")),
                        "collected_at": timestamp,
                    }
                self.save(dataset_id, kind, record_id, payload)
        # Infer roots only through known parents within the same note; never fabricate missing roots.
        comments = {c["comment_id"]: c for c in self.records(dataset_id, "comments")}
        for comment in comments.values():
            cursor, seen = comment, set()
            while not cursor["root_comment_id"] and cursor.get("parent_comment_id") in comments:
                if cursor["comment_id"] in seen:
                    break
                seen.add(cursor["comment_id"])
                parent = comments[cursor["parent_comment_id"]]
                if parent["content_id"] != comment["content_id"]:
                    break
                cursor = parent
            if not comment["root_comment_id"] and cursor.get("root_comment_id"):
                comment["root_comment_id"] = cursor["root_comment_id"]
                self.save(dataset_id, "comments", comment["comment_id"], comment)

    def restore_source_links(self, dataset_id: str, run_dir: Path):
        """Repair historical URL fields from original local files, preserving other data."""
        links = {}
        for file in (run_dir / "xhs" / "jsonl").glob("*_contents_*.jsonl"):
            for line in file.read_text(encoding="utf-8-sig").splitlines():
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue  # A stopped writer may leave an incomplete trailing line.
                content_id = str(raw["note_id"])
                link = source_link(raw.get("note_url"), content_id)
                if link:
                    links[content_id] = link
        for item in self.records(dataset_id, "contents"):
            content_id = item["content_id"]
            # If raw files were removed, retain a complete URL already in SQLite.
            link = links.get(content_id) or source_link(item.get("url"), content_id)
            if item.get("url") != link:
                item["url"] = link
                self.save(dataset_id, "contents", content_id, item)
