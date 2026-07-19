from pathlib import Path

import pytest

from mad.adapters import AdapterError, AdapterResult
from mad.models import AgentProfile
from mad.planning import OrganizerService, PlanError, parse_plan_payload


class OrganizerAdapter:
    prompts: list[tuple[str, str]] = []

    def __init__(self, profile):
        self.profile = profile

    async def invoke(self, prompt, cwd):
        self.prompts.append((self.profile.id, prompt))
        if "一次性组局 Agent" in prompt:
            text = '''```json
{"participants":[{"id":"a","role":"方案主张者"},{"id":"b","role":"风险质疑者"}],"report_agent_id":"b"}
```'''
        else:
            text = "READY"
        return AdapterResult(text, 0.01, text)


class UnhealthyAdapter(OrganizerAdapter):
    async def invoke(self, prompt, cwd):
        if prompt.startswith("只回复 READY") and self.profile.id == "b":
            raise AdapterError("模型未认证")
        return await super().invoke(prompt, cwd)


@pytest.mark.asyncio
async def test_organizer_receives_only_safe_registry_view(tmp_path: Path):
    profiles = [
        AgentProfile(
            "a",
            "A",
            "fake",
            model="private-model",
            executable="/secret/bin/a",
            extra_args=["--token", "secret"],
            role="架构分析",
        ),
        AgentProfile("b", "B", "fake", role="风险审阅"),
        AgentProfile("disabled", "Disabled", "fake", role="不应可见", enabled=False),
    ]
    OrganizerAdapter.prompts.clear()
    service = OrganizerService(profiles, adapter_factory=OrganizerAdapter)
    healthy = await service.preflight(tmp_path, project_mode=False)
    plan = await service.propose("问题", "a", healthy, tmp_path)

    assert plan.agent_ids == ["a", "b"]
    assert plan.report_agent_id == "b"
    prompt = next(value for agent_id, value in OrganizerAdapter.prompts if agent_id == "a" and "一次性组局" in value)
    assert '"id": "a"' in prompt and '"name": "A"' in prompt and '"role": "架构分析"' in prompt
    assert "private-model" not in prompt
    assert "/secret/bin/a" not in prompt
    assert "--token" not in prompt
    assert "secret" not in prompt
    assert "disabled" not in prompt


@pytest.mark.parametrize(
    "payload, message",
    [
        (
            {"participants": [{"id": "a"}, {"id": "unknown"}], "report_agent_id": "a"},
            "未知或预检失败",
        ),
        (
            {
                "participants": [{"id": "a"}, {"id": "b"}],
                "report_agent_id": "a",
                "command": "unsafe",
            },
            "禁止字段",
        ),
        (
            {
                "participants": [{"id": "a", "model": "invented"}, {"id": "b"}],
                "report_agent_id": "a",
            },
            "只能包含",
        ),
    ],
)
def test_plan_parser_rejects_unknown_agents_and_capability_fields(payload, message):
    with pytest.raises(PlanError, match=message):
        parse_plan_payload(payload, allowed_ids={"a", "b"}, organizer_agent_id="a", source="organizer")


@pytest.mark.asyncio
async def test_preflight_failed_profile_is_not_available_to_organizer(tmp_path: Path):
    profiles = [AgentProfile("a", "A", "fake"), AgentProfile("b", "B", "fake")]
    service = OrganizerService(profiles, adapter_factory=UnhealthyAdapter)
    healthy = await service.preflight(tmp_path, project_mode=False)
    assert [item.id for item in healthy] == ["a"]
    with pytest.raises(PlanError, match="未知或预检失败"):
        await service.propose("问题", "a", healthy, tmp_path)
