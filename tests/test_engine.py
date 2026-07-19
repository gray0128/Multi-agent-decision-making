from pathlib import Path

import pytest

from mad.adapters import AdapterResult
from mad.engine import DeliberationEngine
from mad.models import AgentProfile, DeliberationRequest


class FakeAdapter:
    def __init__(self, profile):
        self.profile = profile

    async def invoke(self, prompt, cwd):
        if "最终报告" in prompt and self.profile.id == "a":
            text = "# 最终报告\n\n结论明确。"
        else:
            text = f"{self.profile.id} 的公开观点"
        return AdapterResult(text, 0.01, text)


@pytest.mark.asyncio
async def test_full_deliberation_writes_report(tmp_path: Path):
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
