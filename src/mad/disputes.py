from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any


JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


@dataclass(slots=True)
class ParsedRevision:
    public_text: str
    signal: dict[str, Any] | None
    warning: str | None = None


def parse_revision(text: str) -> ParsedRevision:
    matches = list(JSON_BLOCK.finditer(text))
    if not matches:
        return ParsedRevision(text.strip(), None, "修订意见缺少争议信号 JSON")
    match = matches[-1]
    public = (text[: match.start()] + text[match.end() :]).strip()
    try:
        signal = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        return ParsedRevision(public or text.strip(), None, f"争议信号 JSON 无法解析：{exc.msg}")
    if not isinstance(signal.get("has_critical_dispute"), bool) or not isinstance(signal.get("disputes"), list):
        return ParsedRevision(public or text.strip(), None, "争议信号缺少 has_critical_dispute 或 disputes")
    normalized = []
    for item in signal["disputes"]:
        if isinstance(item, dict) and str(item.get("title", "")).strip() and str(item.get("impact", "")).strip():
            normalized.append({"title": str(item["title"]).strip(), "impact": str(item["impact"]).strip()})
    signal["disputes"] = normalized
    if signal["has_critical_dispute"] and not normalized:
        return ParsedRevision(public or text.strip(), None, "标记存在争议，但争议清单为空")
    return ParsedRevision(public, signal)


def parse_dispute_list(text: str) -> list[dict[str, Any]]:
    matches = list(JSON_BLOCK.finditer(text))
    if not matches:
        return []
    try:
        payload = json.loads(matches[-1].group(1))
    except json.JSONDecodeError:
        return []
    values = payload.get("disputes", [])
    result = []
    for index, item in enumerate(values, 1):
        if not isinstance(item, dict) or not str(item.get("title", "")).strip():
            continue
        result.append(
            {
                "id": str(item.get("id") or f"D{index}"),
                "title": str(item["title"]).strip(),
                "description": str(item.get("description") or item.get("impact") or "").strip(),
                "sources": [str(value) for value in item.get("sources", [])],
            }
        )
    return result


def raw_union(signals: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    result = []
    for agent_id, signal in signals:
        for item in signal.get("disputes", []):
            result.append(
                {
                    "id": f"D{len(result) + 1}",
                    "title": item["title"],
                    "description": item["impact"],
                    "sources": [agent_id],
                }
            )
    return result
