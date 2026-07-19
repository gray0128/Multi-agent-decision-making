from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from .models import Contribution, DeliberationRequest, RunResult
from .state import DeliberationState


class Archive:
    def __init__(self, root: Path, *, archive_id: str | None = None):
        archive_id = archive_id or self.new_id()
        if Path(archive_id).name != archive_id:
            raise ValueError("审议 ID 不能包含路径分隔符")
        self.id = archive_id
        self.path = root / "deliberations" / self.id
        self.path.mkdir(parents=True, exist_ok=False)

    @classmethod
    def open(cls, root: Path, archive_id: str) -> Archive:
        if Path(archive_id).name != archive_id:
            raise ValueError("审议 ID 不能包含路径分隔符")
        value = cls.__new__(cls)
        value.id = archive_id
        value.path = root / "deliberations" / archive_id
        if not value.path.is_dir():
            raise ValueError(f"审议档案不存在：{archive_id}")
        return value

    @staticmethod
    def new_id() -> str:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        return f"{stamp}-{uuid4().hex[:8]}"

    def start(self, request: DeliberationRequest) -> None:
        payload = asdict(request)
        payload["workspace"] = str(request.workspace) if request.workspace else None
        payload.update({"id": self.id, "status": "运行中", "created_at": datetime.now(UTC).isoformat()})
        self._json("metadata.json", payload)

    def append(self, contribution: Contribution) -> None:
        with (self.path / "transcript.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(contribution.to_dict(), ensure_ascii=False) + "\n")

    def replace_transcript(self, contributions: list[Contribution]) -> None:
        value = "".join(json.dumps(item.to_dict(), ensure_ascii=False) + "\n" for item in contributions)
        self._atomic_text("transcript.jsonl", value)

    def diagnostic(self, payload: dict) -> None:
        with (self.path / "diagnostics.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")

    def event(self, payload: dict) -> None:
        with (self.path / "events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")

    def mark_status(self, status: str, *, reason: str | None = None) -> None:
        target = self.path / "metadata.json"
        payload = json.loads(target.read_text(encoding="utf-8"))
        payload["status"] = status
        payload["updated_at"] = datetime.now(UTC).isoformat()
        if reason:
            payload["status_reason"] = reason
        self._json("metadata.json", payload)

    def save_state(self, state: DeliberationState) -> None:
        self._atomic_text("state.json", json.dumps(state.to_dict(), ensure_ascii=False, indent=2, default=str))

    def save_plan(self, plan: dict) -> None:
        self._json("plan.json", plan)

    def load_state(self) -> DeliberationState:
        target = self.path / "state.json"
        if not target.is_file():
            raise ValueError(f"审议 {self.id} 缺少 state.json，无法恢复")
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"审议 {self.id} 的 state.json 已损坏：{exc.msg}") from exc
        if not isinstance(payload, dict):
            raise ValueError(f"审议 {self.id} 的 state.json 格式无效")
        return DeliberationState.from_dict(payload)

    def finish(self, result: RunResult) -> None:
        (self.path / "report.md").write_text(result.report, encoding="utf-8")
        self._json("result.json", result.to_dict())
        self.mark_status(result.status)

    def _json(self, name: str, payload: dict) -> None:
        self._atomic_text(name, json.dumps(payload, ensure_ascii=False, indent=2, default=str))

    def _atomic_text(self, name: str, value: str) -> None:
        target = self.path / name
        temporary = self.path / f".{name}.tmp"
        temporary.write_text(value, encoding="utf-8")
        os.replace(temporary, target)
