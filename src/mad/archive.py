from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from .models import Contribution, DeliberationRequest, RunResult


class Archive:
    def __init__(self, root: Path):
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        self.id = f"{stamp}-{uuid4().hex[:8]}"
        self.path = root / "deliberations" / self.id
        self.path.mkdir(parents=True, exist_ok=False)

    def start(self, request: DeliberationRequest) -> None:
        payload = asdict(request)
        payload["workspace"] = str(request.workspace) if request.workspace else None
        payload.update({"id": self.id, "status": "运行中", "created_at": datetime.now(UTC).isoformat()})
        self._json("metadata.json", payload)

    def append(self, contribution: Contribution) -> None:
        with (self.path / "transcript.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(contribution.to_dict(), ensure_ascii=False) + "\n")

    def diagnostic(self, payload: dict) -> None:
        with (self.path / "diagnostics.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")

    def finish(self, result: RunResult) -> None:
        (self.path / "report.md").write_text(result.report, encoding="utf-8")
        self._json("result.json", result.to_dict())

    def _json(self, name: str, payload: dict) -> None:
        (self.path / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
