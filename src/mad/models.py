from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class Stage(StrEnum):
    OPENING = "独立陈述"
    CRITIQUE = "质疑与补充"
    REVISION = "修订意见"
    DISPUTE_ORGANIZATION = "争议整理"
    DISPUTE_DECISION = "争议判定"
    CONVERGENCE = "争议收敛"
    DRAFT = "报告草稿"
    REVIEW = "报告审阅"
    FINAL = "最终修订"


@dataclass(slots=True)
class AgentProfile:
    id: str
    name: str
    adapter: str
    model: str | None = None
    role: str = ""
    executable: str | None = None
    extra_args: list[str] = field(default_factory=list)
    enabled: bool = True
    default_report: bool = False
    timeout_seconds: int = 300
    context_budget: int = 64_000


@dataclass(slots=True)
class DeliberationRequest:
    question: str
    agent_ids: list[str]
    report_agent_id: str
    workspace: Path | None = None
    direct_workspace: bool = False
    language: str | None = None
    interactive: bool = False
    convergence: str = "auto"


@dataclass(slots=True, frozen=True)
class CheckpointDecision:
    action: str = "continue"
    guidance: str = ""


@dataclass(slots=True)
class Contribution:
    stage: Stage
    agent_id: str
    agent_name: str
    text: str
    duration_seconds: float
    attempts: int
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["stage"] = self.stage.value
        return data


@dataclass(slots=True)
class RunResult:
    deliberation_id: str
    status: str
    report: str
    archive_path: Path
    warnings: list[str]
    participants: list[str]
    convergence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["archive_path"] = str(self.archive_path)
        return data
