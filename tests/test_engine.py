import asyncio
import json
from pathlib import Path

import pytest

from mad.adapters import AdapterError, AdapterResult
from mad.archive import Archive
from mad.engine import DeliberationCancelled, DeliberationEngine
from mad.models import AgentProfile, CheckpointDecision, DeliberationRequest, Stage


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


class FlakyAdapter(FakeAdapter):
    attempts = 0

    async def invoke(self, prompt, cwd):
        self.__class__.attempts += 1
        if self.__class__.attempts == 1:
            raise AdapterError("暂时失败")
        return AdapterResult("重试成功", 0.01, "重试成功")


class BlockingCritiqueAdapter(FakeAdapter):
    partial_ready: asyncio.Event
    release: asyncio.Event
    block = True

    async def invoke(self, prompt, cwd):
        if "阅读已有陈述" in prompt:
            self.calls.append((self.profile.id, prompt))
            if self.profile.id == "a":
                self.partial_ready.set()
                return AdapterResult("a 的未提交质疑", 0.01, "a 的未提交质疑")
            if self.block:
                await self.release.wait()
            return AdapterResult("b 的质疑", 0.01, "b 的质疑")
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


@pytest.mark.asyncio
async def test_stage_call_retries_once_and_records_attempt(tmp_path: Path):
    (tmp_path / "deliberations").mkdir()
    profile = AgentProfile("a", "A", "fake")
    engine = DeliberationEngine([profile], tmp_path, adapter_factory=FlakyAdapter)
    archive = Archive(tmp_path)
    FlakyAdapter.attempts = 0
    result = await engine._one(profile, "PROMPT", tmp_path, Stage.OPENING, archive)
    assert result.text == "重试成功"
    assert result.attempts == 2
    assert FlakyAdapter.attempts == 2


@pytest.mark.asyncio
async def test_cancelled_parallel_stage_is_diagnostic_only_and_reruns_whole_stage(tmp_path: Path):
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir()
    profiles = [AgentProfile("a", "A", "fake"), AgentProfile("b", "B", "fake")]
    BlockingCritiqueAdapter.calls.clear()
    BlockingCritiqueAdapter.partial_ready = asyncio.Event()
    BlockingCritiqueAdapter.release = asyncio.Event()
    BlockingCritiqueAdapter.block = True
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=BlockingCritiqueAdapter)

    task = asyncio.create_task(
        engine.run(DeliberationRequest("问题", ["a", "b"], "a", convergence="never"))
    )
    await asyncio.wait_for(BlockingCritiqueAdapter.partial_ready.wait(), timeout=2)
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    archive_path = next((tmp_path / "deliberations").iterdir())
    state = json.loads((archive_path / "state.json").read_text())
    assert state["status"] == "可恢复"
    assert state["active_stage"] == Stage.CRITIQUE.value
    assert state["completed_stages"] == ["预检", Stage.OPENING.value]
    assert "阅读已有陈述" in state["stage_inputs"][Stage.CRITIQUE.value]
    transcript = [json.loads(line) for line in (archive_path / "transcript.jsonl").read_text().splitlines()]
    assert {row["stage"] for row in transcript} == {Stage.OPENING.value}
    diagnostics = [json.loads(line) for line in (archive_path / "diagnostics.jsonl").read_text().splitlines()]
    assert any(row["kind"] == "partial_stage_output" and row["stage"] == Stage.CRITIQUE.value for row in diagnostics)
    workdir = Path(state["workdir"])
    assert (workdir / ".mad-recoverable").is_file()

    BlockingCritiqueAdapter.block = False
    result = await DeliberationEngine(
        profiles, tmp_path, adapter_factory=BlockingCritiqueAdapter
    ).resume(archive_path.name)
    assert result.status == "完成"
    assert not workdir.exists()
    opening_calls = [prompt for _, prompt in BlockingCritiqueAdapter.calls if "独立分析问题" in prompt]
    critique_calls = [prompt for _, prompt in BlockingCritiqueAdapter.calls if "阅读已有陈述" in prompt]
    assert len(opening_calls) == 2
    assert len(critique_calls) == 4
    assert len(set(critique_calls)) == 1
    rows = [json.loads(line) for line in (archive_path / "transcript.jsonl").read_text().splitlines()]
    assert len([row for row in rows if row["stage"] == Stage.CRITIQUE.value]) == 2
    assert [(row["stage"], row["agent_id"]) for row in rows] == [
        (Stage.OPENING.value, "a"),
        (Stage.OPENING.value, "b"),
        (Stage.CRITIQUE.value, "a"),
        (Stage.CRITIQUE.value, "b"),
        (Stage.REVISION.value, "a"),
        (Stage.REVISION.value, "b"),
        (Stage.DRAFT.value, "a"),
        (Stage.REVIEW.value, "b"),
        (Stage.FINAL.value, "a"),
    ]


@pytest.mark.asyncio
async def test_pending_checkpoint_resumes_without_rerunning_committed_stage(tmp_path: Path):
    for name in ("deliberations", "temp"):
        (tmp_path / name).mkdir()
    profiles = [AgentProfile("a", "A", "fake"), AgentProfile("b", "B", "fake")]
    FakeAdapter.calls.clear()
    engine = DeliberationEngine(profiles, tmp_path, adapter_factory=FakeAdapter)

    async def cancel(_stage, _items):
        return CheckpointDecision(action="cancel")

    with pytest.raises(DeliberationCancelled):
        await engine.run(
            DeliberationRequest("问题", ["a", "b"], "a", interactive=True, convergence="never"),
            checkpoint=cancel,
        )
    archive_path = next((tmp_path / "deliberations").iterdir())
    persisted = json.loads((archive_path / "state.json").read_text())
    assert persisted["pending_checkpoint"] == Stage.OPENING.value

    seen = []

    async def proceed(stage, _items):
        seen.append(stage)
        return CheckpointDecision()

    result = await engine.resume(archive_path.name, checkpoint=proceed)
    assert result.status == "完成"
    assert seen[0] == Stage.OPENING
    opening_calls = [prompt for _, prompt in FakeAdapter.calls if "独立分析问题" in prompt]
    assert len(opening_calls) == 2


def test_resume_rejects_corrupt_or_incompatible_state(tmp_path: Path):
    (tmp_path / "deliberations").mkdir()
    archive = Archive(tmp_path)
    (archive.path / "state.json").write_text("not-json")
    with pytest.raises(ValueError, match="已损坏"):
        archive.load_state()

    (archive.path / "state.json").write_text('{"schema_version": 999}')
    with pytest.raises(ValueError, match="不支持"):
        archive.load_state()
