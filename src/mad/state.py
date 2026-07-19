from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import Contribution, DeliberationRequest, Stage


STATE_SCHEMA_VERSION = 1


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class DeliberationState:
    deliberation_id: str
    request: dict[str, Any]
    status: str
    workdir: str
    temporary_workspace: bool
    schema_version: int = STATE_SCHEMA_VERSION
    participants: list[str] = field(default_factory=list)
    report_agent_id: str = ""
    profile_fingerprints: dict[str, dict[str, Any]] = field(default_factory=dict)
    completed_stages: list[str] = field(default_factory=list)
    active_stage: str | None = None
    stage_inputs: dict[str, str] = field(default_factory=dict)
    pending_checkpoint: str | None = None
    transcript: list[dict[str, Any]] = field(default_factory=list)
    guidance: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    convergence: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    @classmethod
    def create(
        cls,
        deliberation_id: str,
        request: DeliberationRequest,
        workdir: Path,
        *,
        temporary_workspace: bool,
    ) -> DeliberationState:
        payload = asdict(request)
        payload["workspace"] = str(request.workspace) if request.workspace else None
        return cls(
            deliberation_id=deliberation_id,
            request=payload,
            status="运行中",
            workdir=str(workdir),
            temporary_workspace=temporary_workspace,
            report_agent_id=request.report_agent_id,
            convergence={
                "strategy": request.convergence,
                "triggered": False,
                "reason": "阈值未满足",
                "marked_participants": 0,
                "disputes": [],
                "status": "未触发",
            },
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> DeliberationState:
        version = payload.get("schema_version")
        if version != STATE_SCHEMA_VERSION:
            raise ValueError(f"不支持的审议状态版本：{version}")
        required = {"deliberation_id", "request", "status", "workdir", "temporary_workspace"}
        missing = sorted(required - payload.keys())
        if missing:
            raise ValueError(f"审议状态缺少字段：{', '.join(missing)}")
        return cls(**payload)

    def to_dict(self) -> dict[str, Any]:
        self.updated_at = _now()
        return asdict(self)

    def to_request(self) -> DeliberationRequest:
        payload = dict(self.request)
        payload["workspace"] = Path(payload["workspace"]) if payload.get("workspace") else None
        return DeliberationRequest(**payload)

    def contributions(self) -> list[Contribution]:
        return [
            Contribution(
                stage=Stage(row["stage"]),
                agent_id=row["agent_id"],
                agent_name=row["agent_name"],
                text=row["text"],
                duration_seconds=row["duration_seconds"],
                attempts=row["attempts"],
                metadata=dict(row.get("metadata", {})),
            )
            for row in self.transcript
        ]

    def stage_items(self, stage: Stage) -> list[Contribution]:
        return [item for item in self.contributions() if item.stage == stage]

    def stage_completed(self, stage: Stage | str) -> bool:
        value = stage.value if isinstance(stage, Stage) else stage
        return value in self.completed_stages

    def begin_stage(self, stage: Stage | str, input_text: str | None = None) -> None:
        value = stage.value if isinstance(stage, Stage) else stage
        self.active_stage = value
        if input_text is not None:
            self.stage_inputs[value] = input_text
        self.status = "运行中"

    def commit_stage(self, stage: Stage | str, items: list[Contribution]) -> None:
        value = stage.value if isinstance(stage, Stage) else stage
        if value in self.completed_stages:
            raise ValueError(f"阶段已经提交：{value}")
        self.transcript.extend(item.to_dict() for item in items)
        self.completed_stages.append(value)
        self.active_stage = None
