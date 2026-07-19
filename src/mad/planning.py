from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .adapters import AdapterError, CliAdapter, PreflightResult
from .models import AgentProfile


_JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


class PlanError(ValueError):
    pass


@dataclass(slots=True, frozen=True)
class PlanParticipant:
    id: str
    role: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "role": self.role}


@dataclass(slots=True, frozen=True)
class DeliberationPlan:
    participants: list[PlanParticipant]
    report_agent_id: str
    organizer_agent_id: str | None = None
    source: str = "manual"

    @property
    def agent_ids(self) -> list[str]:
        return [item.id for item in self.participants]

    @property
    def roles(self) -> dict[str, str]:
        return {item.id: item.role for item in self.participants if item.role}

    def to_dict(self) -> dict[str, Any]:
        return {
            "participants": [item.to_dict() for item in self.participants],
            "report_agent_id": self.report_agent_id,
            "organizer_agent_id": self.organizer_agent_id,
            "source": self.source,
        }


def validate_plan(plan: DeliberationPlan, allowed_ids: set[str]) -> DeliberationPlan:
    ids = plan.agent_ids
    if len(ids) < 2:
        raise PlanError("审议方案至少需要两个参与者")
    if len(ids) != len(set(ids)):
        raise PlanError("审议方案包含重复参与者")
    unknown = sorted(set(ids) - allowed_ids)
    if unknown:
        raise PlanError(f"审议方案包含未知或预检失败的 Agent：{', '.join(unknown)}")
    if plan.report_agent_id not in ids:
        raise PlanError("报告 Agent 必须是审议方案参与者")
    for participant in plan.participants:
        if len(participant.role) > 500:
            raise PlanError(f"临时角色过长：{participant.id}")
    return plan


def parse_plan_payload(
    payload: str | dict[str, Any],
    *,
    allowed_ids: set[str],
    organizer_agent_id: str | None = None,
    source: str = "manual",
) -> DeliberationPlan:
    if isinstance(payload, str):
        match = _JSON_BLOCK.search(payload)
        raw = match.group(1) if match else payload.strip()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise PlanError(f"审议方案不是有效 JSON：{exc.msg}") from exc
    else:
        value = payload
    if not isinstance(value, dict):
        raise PlanError("审议方案必须是 JSON 对象")
    allowed_keys = {"participants", "report_agent_id"}
    extras = sorted(set(value) - allowed_keys)
    if extras:
        raise PlanError(f"审议方案包含禁止字段：{', '.join(extras)}")
    participants = value.get("participants")
    if not isinstance(participants, list):
        raise PlanError("participants 必须是数组")
    parsed = []
    for index, item in enumerate(participants):
        if not isinstance(item, dict) or set(item) - {"id", "role"}:
            raise PlanError(f"participants[{index}] 只能包含 id 和 role")
        agent_id = item.get("id")
        role = item.get("role", "")
        if not isinstance(agent_id, str) or not agent_id or not isinstance(role, str):
            raise PlanError(f"participants[{index}] 的 id/role 格式无效")
        parsed.append(PlanParticipant(agent_id, role.strip()))
    report_agent_id = value.get("report_agent_id")
    if not isinstance(report_agent_id, str) or not report_agent_id:
        raise PlanError("report_agent_id 必须是非空字符串")
    return validate_plan(
        DeliberationPlan(parsed, report_agent_id, organizer_agent_id, source),
        allowed_ids,
    )


def manual_plan(
    profiles: list[AgentProfile],
    agent_ids: list[str],
    report_agent_id: str,
    role_overrides: dict[str, str] | None = None,
    *,
    allowed_ids: set[str] | None = None,
    organizer_agent_id: str | None = None,
) -> DeliberationPlan:
    registry = {item.id: item for item in profiles}
    overrides = role_overrides or {}
    unknown_overrides = sorted(set(overrides) - set(agent_ids))
    if unknown_overrides:
        raise PlanError(f"临时角色指定了非参与者：{', '.join(unknown_overrides)}")
    participants = [
        PlanParticipant(agent_id, overrides.get(agent_id, registry.get(agent_id).role if agent_id in registry else ""))
        for agent_id in agent_ids
    ]
    return validate_plan(
        DeliberationPlan(
            participants,
            report_agent_id,
            organizer_agent_id,
            "organizer" if organizer_agent_id else "manual",
        ),
        allowed_ids if allowed_ids is not None else {item.id for item in profiles if item.enabled},
    )


class OrganizerService:
    def __init__(self, profiles: list[AgentProfile], *, adapter_factory=CliAdapter):
        self.profiles = {item.id: item for item in profiles}
        self.adapter_factory = adapter_factory
        self.preflight_results: dict[str, PreflightResult] = {}

    async def preflight(self, cwd: Path, *, project_mode: bool) -> list[AgentProfile]:
        enabled = [item for item in self.profiles.values() if item.enabled]
        results = await asyncio.gather(
            *(self._preflight(item, cwd, project_mode=project_mode) for item in enabled)
        )
        self.preflight_results = dict(zip((item.id for item in enabled), results, strict=True))
        return [item for item, result in zip(enabled, results, strict=True) if result.ready]

    async def propose(
        self,
        question: str,
        organizer_agent_id: str,
        healthy_profiles: list[AgentProfile],
        cwd: Path,
    ) -> DeliberationPlan:
        healthy = {item.id: item for item in healthy_profiles}
        organizer = healthy.get(organizer_agent_id)
        if organizer is None:
            raise PlanError(f"组局 Agent 未启用或预检失败：{organizer_agent_id}")
        safe_registry = [
            {"id": item.id, "name": item.name, "role": item.role}
            for item in healthy_profiles
        ]
        prompt = f"""你是一次性组局 Agent。只能从给定注册表选择至少两个参与者，并指定每人的本次临时角色和其中一名报告 Agent。不得建议或输出命令、可执行路径、模型、CLI 参数、环境变量、秘密或注册表修改。

问题：
{question}

可信 Agent 注册表安全视图：
{json.dumps(safe_registry, ensure_ascii=False, indent=2)}

只输出一个 JSON 对象，且只能包含以下结构：
{{"participants":[{{"id":"已存在的 ID","role":"本次临时角色"}}],"report_agent_id":"参与者 ID"}}"""
        try:
            result = await self.adapter_factory(organizer).invoke(prompt, cwd)
        except AdapterError as exc:
            raise PlanError(f"组局 Agent 调用失败：{exc}") from exc
        return parse_plan_payload(
            result.text,
            allowed_ids=set(healthy),
            organizer_agent_id=organizer_agent_id,
            source="organizer",
        )

    async def _preflight(self, profile: AgentProfile, cwd: Path, *, project_mode: bool) -> PreflightResult:
        adapter = self.adapter_factory(profile)
        preflight = getattr(adapter, "preflight", None)
        if preflight:
            return await preflight(cwd, project_mode=project_mode)
        try:
            await adapter.invoke("只回复 READY，不要执行任何工具。", cwd)
        except AdapterError as exc:
            return PreflightResult(True, False, True, 0, str(exc))
        return PreflightResult(True, True, True, 0)
