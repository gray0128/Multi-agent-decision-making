import json
from pathlib import Path

import pytest

from mad.adapters import AdapterResult
from mad.engine import DeliberationEngine
from mad.models import AgentProfile, DeliberationRequest


class FakeAdapter:
    calls = []

    def __init__(self, profile):
        self.profile = profile

    async def invoke(self, prompt, cwd):
        self.calls.append((self.profile.id, prompt))
        if "只负责整理争议" in prompt:
            text = '```json\n{"disputes":[{"id":"D1","title":"关键方案分歧","description":"改变建议","sources":["a","b"]}]}\n```'
        elif "has_critical_dispute" in prompt:
            text = f'''{self.profile.id} 的修订观点
```json
{{"has_critical_dispute": true, "disputes": [{{"title": "关键方案分歧", "impact": "会改变最终建议"}}]}}
```'''
        elif "最终报告" in prompt and self.profile.id == "a":
            text = "# 最终报告\n\n结论明确。"
        else:
            text = f"{self.profile.id} 的公开观点"
        return AdapterResult(text, 0.01, text)


class OneSignalAdapter(FakeAdapter):
    async def invoke(self, prompt, cwd):
        if "has_critical_dispute" in prompt and "只负责整理争议" not in prompt:
            flag = self.profile.id == "a"
            disputes = '[{"title":"单方争议","impact":"影响结论"}]' if flag else "[]"
            text = f'修订观点\n```json\n{{"has_critical_dispute":{str(flag).lower()},"disputes":{disputes}}}\n```'
            return AdapterResult(text, 0.01, text)
        return await super().invoke(prompt, cwd)


class NoSignalAdapter(FakeAdapter):
    async def invoke(self, prompt, cwd):
        if "has_critical_dispute" in prompt and "只负责整理争议" not in prompt:
            return AdapterResult("缺少结构化信号的修订观点", 0.01, "")
        return await super().invoke(prompt, cwd)


@pytest.mark.asyncio
async def test_full_deliberation_writes_report(tmp_path: Path):
    FakeAdapter.calls.clear()
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir()
    profiles = [
        AgentProfile("a", "A", "fake", default_report=True),
        AgentProfile("b", "B", "fake"),
    ]
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=FakeAdapter)
    result = await engine.run(DeliberationRequest("问题", ["a", "b"], "a"))
    assert result.status == "完成"
    assert (result.archive_path / "report.md").read_text() == result.report
    assert not any((tmp_path / "temp").iterdir())
    transcript = (result.archive_path / "transcript.jsonl").read_text()
    assert "争议收敛" in transcript
    assert result.convergence["triggered"] is True
    assert result.convergence["reason"] == "至少两名参与者标记关键争议"
    assert result.convergence["status"] == "已完成"
    rows = [json.loads(line) for line in transcript.splitlines()]
    revisions = [row for row in rows if row["stage"] == "修订意见"]
    assert all("```json" not in row["text"] for row in revisions)
    assert all(row["metadata"]["dispute_signal"]["has_critical_dispute"] for row in revisions)


@pytest.mark.asyncio
async def test_never_strategy_skips_convergence(tmp_path: Path):
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir()
    profiles = [AgentProfile("a", "A", "fake"), AgentProfile("b", "B", "fake")]
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=FakeAdapter)
    result = await engine.run(DeliberationRequest("问题", ["a", "b"], "a", convergence="never"))
    assert "争议收敛" not in (result.archive_path / "transcript.jsonl").read_text()
    assert result.convergence["reason"] == "策略禁止触发"


@pytest.mark.asyncio
async def test_auto_requires_two_marked_participants(tmp_path: Path):
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir()
    profiles = [AgentProfile("a", "A", "fake"), AgentProfile("b", "B", "fake")]
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=OneSignalAdapter)
    result = await engine.run(DeliberationRequest("问题", ["a", "b"], "a"))
    assert "争议收敛" not in (result.archive_path / "transcript.jsonl").read_text()


@pytest.mark.asyncio
async def test_always_can_propose_disputes_without_valid_signals(tmp_path: Path):
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir()
    profiles = [AgentProfile("a", "A", "fake"), AgentProfile("b", "B", "fake")]
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=NoSignalAdapter)
    result = await engine.run(DeliberationRequest("问题", ["a", "b"], "a", convergence="always"))
    assert "争议收敛" in (result.archive_path / "transcript.jsonl").read_text()
