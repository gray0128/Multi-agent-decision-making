from __future__ import annotations

import json
from pathlib import Path

import pytest

from mad.adapters import AdapterResult
from mad.devui import (
    DeliberationExecutor,
    DevUiCheckpointRequest,
    DevUiCheckpointResponse,
    DevUiPlanRequest,
    DevUiPlanResponse,
    DevUiRequest,
    build_workflow,
    serve,
)
from mad.engine import DeliberationCancelled, DeliberationEngine
from mad.models import AgentProfile, CheckpointDecision, DeliberationRequest


def test_serve_prints_generated_auth_token(monkeypatch, capsys):
    captured = {}
    monkeypatch.delenv("DEVUI_AUTH_TOKEN", raising=False)
    monkeypatch.setattr("mad.devui.secrets.token_urlsafe", lambda _size: "generated-token")
    monkeypatch.setattr("mad.devui.build_workflow", lambda: "workflow")
    monkeypatch.setattr("agent_framework_devui.serve", lambda **kwargs: captured.update(kwargs))

    serve(9090, auto_open=False)

    assert capsys.readouterr().err == "DevUI Bearer Token（仅本机使用，请勿分享）：\ngenerated-token\n"
    assert captured["auth_token"] == "generated-token"
    assert captured["auth_enabled"] is True
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 9090
    assert captured["auto_open"] is False


def test_serve_uses_configured_auth_token_without_printing_it(monkeypatch, capsys):
    captured = {}
    monkeypatch.setenv("DEVUI_AUTH_TOKEN", "configured-token")
    monkeypatch.setattr("mad.devui.build_workflow", lambda: "workflow")
    monkeypatch.setattr("agent_framework_devui.serve", lambda **kwargs: captured.update(kwargs))

    serve()

    assert capsys.readouterr().err == ""
    assert captured["auth_token"] == "configured-token"


def test_devui_usage_model_accepts_mapper_fallback_payload():
    from agent_framework_devui._mapper import InputTokensDetails

    details = InputTokensDetails(cached_tokens=0)

    assert details.cached_tokens == 0


class FakeAdapter:
    calls: list[tuple[str, str]] = []

    def __init__(self, profile):
        self.profile = profile

    async def invoke(self, prompt, cwd):
        self.calls.append((self.profile.id, prompt))
        if "一次性组局 Agent" in prompt:
            text = '{"participants":[{"id":"a","role":"主张者"},{"id":"b","role":"质疑者"}],"report_agent_id":"a"}'
        elif "只负责整理争议" in prompt:
            text = '```json\n{"disputes":[{"id":"D1","title":"方案分歧","description":"影响建议","sources":["a","b"]}]}\n```'
        elif "has_critical_dispute" in prompt:
            text = f'''{self.profile.id} 的修订观点
```json
{{"has_critical_dispute": true, "disputes": [{{"title": "方案分歧", "impact": "改变建议"}}]}}
```'''
        elif "最终报告" in prompt and self.profile.id == "a":
            text = "# 最终报告\n\n完成。"
        else:
            text = f"{self.profile.id} 的公开观点"
        return AdapterResult(text, 0.01, text)


def make_workflow(tmp_path: Path):
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir(exist_ok=True)
    profiles = [
        AgentProfile("a", "A", "fake", default_report=True),
        AgentProfile("b", "B", "fake"),
    ]
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=FakeAdapter)
    return build_workflow(engine)


def only_request(result):
    requests = result.get_request_info_events()
    assert len(requests) == 1
    return requests[0]


def response_for(request_event, *, action="continue", guidance=""):
    request = request_event.data
    assert isinstance(request, DevUiCheckpointRequest)
    return DevUiCheckpointResponse(
        deliberation_id=request.deliberation_id,
        interrupt_id=request.interrupt_id,
        action=action,
        guidance=guidance,
    )


async def start_confirmed(workflow, request, *, participants=None, report_agent_id=""):
    result = await workflow.run(request)
    event = only_request(result)
    plan = event.data
    assert isinstance(plan, DevUiPlanRequest)
    response = DevUiPlanResponse(
        deliberation_id=plan.deliberation_id,
        interrupt_id=plan.interrupt_id,
        participants=participants or [],
        report_agent_id=report_agent_id,
    )
    return await workflow.run(responses={event.request_id: response}), event


@pytest.mark.asyncio
async def test_guided_devui_pauses_at_four_checkpoints_and_resumes(tmp_path: Path):
    FakeAdapter.calls.clear()
    workflow = make_workflow(tmp_path)
    result, _plan = await start_confirmed(
        workflow, DevUiRequest("问题", agents=["a", "b"], report_agent="a")
    )
    seen = []

    first = only_request(result)
    seen.append(first)
    result = await workflow.run(
        responses={first.request_id: response_for(first, action="guidance", guidance="下一阶段指导")}
    )
    second = only_request(result)
    seen.append(second)
    result = await workflow.run(responses={second.request_id: response_for(second)})
    third = only_request(result)
    seen.append(third)

    dispute = third.data
    assert dispute.stage == "争议判定"
    assert dispute.threshold == 2
    assert dispute.recommended_action == "trigger"
    assert len(dispute.participants) == 2
    assert all(value["signal_valid"] for value in dispute.participants)
    assert len(dispute.disputes) == 2

    result = await workflow.run(responses={third.request_id: response_for(third, action="skip")})
    fourth = only_request(result)
    seen.append(fourth)
    result = await workflow.run(responses={fourth.request_id: response_for(fourth)})

    assert [value.data.stage for value in seen] == ["独立陈述", "质疑与补充", "争议判定", "报告草稿"]
    assert len({value.request_id for value in seen}) == 4
    deliberation_ids = {value.data.deliberation_id for value in seen}
    assert len(deliberation_ids) == 1
    assert all(value.request_id == value.data.interrupt_id for value in seen)
    assert result.get_outputs() == ["# 最终报告\n\n完成。"]
    assert not result.get_request_info_events()

    opening_prompts = [prompt for _, prompt in FakeAdapter.calls if "独立分析问题" in prompt]
    critique_prompts = [prompt for _, prompt in FakeAdapter.calls if "阅读已有陈述" in prompt]
    assert opening_prompts and all("下一阶段指导" not in prompt for prompt in opening_prompts)
    assert critique_prompts and all("下一阶段指导" in prompt for prompt in critique_prompts)

    deliberation_id = next(iter(deliberation_ids))
    events = [
        json.loads(line)
        for line in (tmp_path / "deliberations" / deliberation_id / "events.jsonl").read_text().splitlines()
    ]
    assert {event["type"] for event in events} == {"stage_committed", "user_guidance", "dispute_override"}
    assert next(event for event in events if event["type"] == "user_guidance")["text"] == "下一阶段指导"
    assert next(event for event in events if event["type"] == "dispute_override")["action"] == "skip"
    metadata = json.loads(
        (tmp_path / "deliberations" / deliberation_id / "metadata.json").read_text()
    )
    assert metadata["status"] == "完成"


@pytest.mark.asyncio
async def test_automatic_devui_run_has_no_normal_checkpoints(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    result, plan = await start_confirmed(
        workflow,
        DevUiRequest("问题", agents=["a", "b"], report_agent="a", interactive=False, convergence="never"),
    )
    assert isinstance(plan.data, DevUiPlanRequest)
    assert result.get_request_info_events() == []
    assert result.get_outputs() == ["# 最终报告\n\n完成。"]


@pytest.mark.asyncio
async def test_devui_deduplicates_initial_agent_selection(tmp_path: Path):
    workflow = make_workflow(tmp_path)

    result = await workflow.run(DevUiRequest("问题", agents=["a", "a", "b"], report_agent="a"))

    plan = only_request(result).data
    assert isinstance(plan, DevUiPlanRequest)
    assert [participant["id"] for participant in plan.plan["participants"]] == ["a", "b"]


@pytest.mark.asyncio
async def test_wrong_response_ids_are_rejected_without_advancing(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    result, _plan = await start_confirmed(
        workflow, DevUiRequest("问题", agents=["a", "b"], report_agent="a")
    )
    first = only_request(result)
    wrong = response_for(first)
    wrong.deliberation_id = "wrong-id"
    result = await workflow.run(responses={first.request_id: wrong})
    repeated = only_request(result)
    assert repeated.request_id != first.request_id
    assert repeated.data.stage == "独立陈述"
    assert any(event.type == "warning" and "审议 ID 不匹配" in event.data for event in result)

    wrong_interrupt = response_for(repeated)
    wrong_interrupt.interrupt_id = "wrong-interrupt"
    result = await workflow.run(responses={repeated.request_id: wrong_interrupt})
    repeated_again = only_request(result)
    assert repeated_again.request_id not in {first.request_id, repeated.request_id}
    assert repeated_again.data.stage == "独立陈述"
    assert any(event.type == "warning" and "中断 ID 不匹配" in event.data for event in result)

    invalid_action = response_for(repeated_again)
    invalid_action.action = "invalid"
    result = await workflow.run(responses={repeated_again.request_id: invalid_action})
    final_retry = only_request(result)
    assert final_retry.data.stage == "独立陈述"
    assert any(event.type == "warning" and "不支持动作" in event.data for event in result)

    result = await workflow.run(responses={final_retry.request_id: response_for(final_retry)})
    second = only_request(result)
    assert second.data.stage == "质疑与补充"
    await workflow.run(responses={second.request_id: response_for(second, action="cancel")})


@pytest.mark.asyncio
async def test_duplicate_response_is_rejected_without_consuming_current_checkpoint(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    result, _plan = await start_confirmed(
        workflow, DevUiRequest("问题", agents=["a", "b"], report_agent="a")
    )
    first = only_request(result)
    result = await workflow.run(responses={first.request_id: response_for(first)})
    second = only_request(result)

    with pytest.raises(ValueError, match="unknown request ID"):
        await workflow.run(responses={first.request_id: response_for(first)})

    result = await workflow.run(responses={second.request_id: response_for(second)})
    third = only_request(result)
    assert third.data.stage == "争议判定"
    await workflow.run(responses={third.request_id: response_for(third, action="cancel")})


@pytest.mark.asyncio
async def test_cancel_cleans_live_session(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    executor = next(value for value in workflow.get_executors_list() if isinstance(value, DeliberationExecutor))
    result, _plan = await start_confirmed(
        workflow, DevUiRequest("问题", agents=["a", "b"], report_agent="a")
    )
    request = only_request(result)
    result = await workflow.run(responses={request.request_id: response_for(request, action="cancel")})
    assert "已取消" in result.get_outputs()[0]
    assert executor.sessions == {}
    metadata = json.loads(
        (tmp_path / "deliberations" / request.data.deliberation_id / "metadata.json").read_text()
    )
    assert metadata["status"] == "可恢复"
    assert metadata["status_reason"] == "用户取消审议"


@pytest.mark.asyncio
async def test_expired_session_returns_diagnostic_output(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    executor = next(value for value in workflow.get_executors_list() if isinstance(value, DeliberationExecutor))
    result, _plan = await start_confirmed(
        workflow, DevUiRequest("问题", agents=["a", "b"], report_agent="a")
    )
    request = only_request(result)
    session = executor.sessions.pop(request.data.deliberation_id)
    await session.close()

    result = await workflow.run(responses={request.request_id: response_for(request)})
    assert "已过期" in result.get_outputs()[0]
    assert any(event.type == "warning" and "已过期" in event.data for event in result)


@pytest.mark.asyncio
async def test_devui_can_reopen_persisted_checkpoint_after_process_loss(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    executor = next(value for value in workflow.get_executors_list() if isinstance(value, DeliberationExecutor))

    async def cancel(_stage, _items):
        return CheckpointDecision(action="cancel")

    with pytest.raises(DeliberationCancelled):
        await executor.engine.run(
            DeliberationRequest("问题", ["a", "b"], "a", interactive=True, convergence="never"),
            checkpoint=cancel,
        )
    deliberation_id = next((tmp_path / "deliberations").iterdir()).name

    result = await workflow.run(DevUiRequest("", resume_id=deliberation_id))
    request = only_request(result)
    assert request.data.deliberation_id == deliberation_id
    assert request.data.stage == "独立陈述"
    result = await workflow.run(responses={request.request_id: response_for(request, action="cancel")})
    assert "已取消" in result.get_outputs()[0]


@pytest.mark.asyncio
async def test_devui_user_can_modify_organizer_plan_before_start(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    result = await workflow.run(
        DevUiRequest("问题", organizer="a", interactive=False, convergence="never")
    )
    event = only_request(result)
    assert isinstance(event.data, DevUiPlanRequest)
    assert event.data.plan["source"] == "organizer"
    assert all(set(item) == {"id", "name", "role"} for item in event.data.available_agents)
    response = DevUiPlanResponse(
        event.data.deliberation_id,
        event.data.interrupt_id,
        participants=[{"id": "a", "role": "反方"}, {"id": "b", "role": "报告人"}],
        report_agent_id="b",
    )
    result = await workflow.run(responses={event.request_id: response})
    assert result.get_request_info_events() == []
    archive = tmp_path / "deliberations" / event.data.deliberation_id
    archived = json.loads((archive / "result.json").read_text())
    assert archived["plan"]["report_agent_id"] == "b"
    assert archived["plan"]["participants"] == [
        {"id": "a", "name": "A", "adapter": "fake", "model": None, "role": "反方"},
        {"id": "b", "name": "B", "adapter": "fake", "model": None, "role": "报告人"},
    ]


@pytest.mark.asyncio
async def test_devui_rejects_unknown_agent_in_plan_confirmation(tmp_path: Path):
    workflow = make_workflow(tmp_path)
    result = await workflow.run(DevUiRequest("问题", agents=["a", "b"], report_agent="a"))
    event = only_request(result)
    response = DevUiPlanResponse(
        event.data.deliberation_id,
        event.data.interrupt_id,
        participants=[{"id": "a"}, {"id": "unknown"}],
        report_agent_id="a",
    )
    result = await workflow.run(responses={event.request_id: response})
    replacement = only_request(result)
    assert isinstance(replacement.data, DevUiPlanRequest)
    assert replacement.request_id != event.request_id
    assert any(event.type == "warning" and "未知或预检失败" in event.data for event in result)
    await workflow.run(
        responses={
            replacement.request_id: DevUiPlanResponse(
                replacement.data.deliberation_id,
                replacement.data.interrupt_id,
                action="cancel",
            )
        }
    )
