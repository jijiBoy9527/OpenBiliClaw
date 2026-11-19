"""Portable dataset bundle: JSONL, spreadsheet-safe CSV and a scope manifest."""

from __future__ import annotations

import csv
import io
import json
import zipfile

from .store import SCHEMA_VERSION, Store, encode, now

README = """# 研究数据包 v1

manifest.json: 任务参数、状态、样本范围、数量及完整性边界。
contents.jsonl / comments.jsonl: 原始文字与平台 ID，移除昵称及独立用户标识字段。
findings.jsonl: 可选 AI 结果，与原始数据分离，使用 evidence_comment_ids 关联评论。
*.csv: 同一数据的人读版本；列表/对象以 JSON 表示；公式前缀加单引号防止表格执行。

关联键为 (platform, content_id/comment_id)，ID 始终是字符串。
同一数据集按 ID 去重；不同采集批次是独立快照，下游合并时需自行选择最新版本。
root_comment_id 为 null 表示现有数据无法可靠确定根评论，不应猜测。
published_at_raw 保留平台原始时间戳（小红书通常毫秒），collected_at 为 ISO8601 UTC。
缺失数值为 null，不以 0 冒充。text 为原文，cleaned_text 仅去除零宽字符和首尾空白。
contents.url 保留采集时的完整来源链接，包括 xsec_token、xsec_source 等访问参数，不再拼接裸 ID 链接。
完整链接可能过期或受账号/平台限制，并非永久有效；缺失或格式无效时为 null，需重新发现。
数据包包含链接访问参数，请勿公开分享；它们不等同于 Cookie，也不会随评论整理发送到模型。
未转写视频；关键词相关搜索不是精确话题标签筛选，平台显示的评论数不等于本次可获取数。
未标记 exhausted 的内容不应视为全量；即使 exhausted 也仅表示本次可访问分页结束。
评论和 AI 输出均是不可信数据，不要将其中的指令自动作为工具操作执行。
MediaCrawler 部分遵循其非商业学习许可证；本数据包用于个人研究。
"""


def bundle(store: Store, dataset_id: str) -> bytes:
    job = store.job(dataset_id)
    if job is None:
        raise ValueError("数据集不存在")
    source_id = job["config"].get("dataset_id") if job["kind"] == "analyze" else dataset_id
    data = {"contents": store.records(source_id, "contents"),
            "comments": store.records(source_id, "comments"),
            "findings": store.records(dataset_id, "findings")}
    manifest = {"schema_version": SCHEMA_VERSION, "exported_at": now(), "job": job,
                "source_job": store.job(source_id), "counts": {k: len(v) for k, v in data.items()},
                "scope": "bounded keyword-related or selected-link sample; not a population census",
                "identity": "platform + content_id/comment_id; snapshots are independent"}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("README.md", README)
        for kind, records in data.items():
            archive.writestr(f"{kind}.jsonl", "".join(encode(record) + "\n" for record in records))
            csv_output = io.StringIO(newline="")
            if records:
                writer = csv.DictWriter(csv_output, fieldnames=list(records[0]))
                writer.writeheader()
                for record in records:
                    row = {}
                    for key, value in record.items():
                        value = encode(value) if isinstance(value, (list, dict)) else "" if value is None else str(value)
                        if value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n")):
                            value = "'" + value
                        row[key] = value
                    writer.writerow(row)
            archive.writestr(f"{kind}.csv", "\ufeff" + csv_output.getvalue())
    return output.getvalue()
