from __future__ import annotations

import asyncio
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path

from .adapters import AdapterError, CliAdapter
from .archive import Archive
from .models import AgentProfile, Contribution, DeliberationRequest, RunResult, Stage
from .snapshot import create_snapshot


Checkpoint = Callable[[Stage, list[Contribution]], Awaitable[str | None]]
Progress = Callable[[str], None]


class DeliberationError(RuntimeError):
    pass


class DeliberationEngine:
    def __init__(self, profiles: list[AgentProfile], home: Path, *, concurrency: int = 6, adapter_factory=CliAdapter):
        self.profiles = {profile.id: profile for profile in profiles}
        self.home = home
        self.semaphore = asyncio.Semaphore(concurrency)
        self.adapter_factory = adapter_factory

    async def run(
        self,
        request: DeliberationRequest,
        *,
        checkpoint: Checkpoint | None = None,
        progress: Progress = lambda _: None,
    ) -> RunResult:
        selected = [self._profile(agent_id) for agent_id in request.agent_ids]
        if len(selected) < 2:
            raise DeliberationError("一次审议至少需要两个参与者")
        report_agent = self._profile(request.report_agent_id)
        if report_agent not in selected:
            raise DeliberationError("报告 Agent 必须是参与者")
        archive = Archive(self.home)
        archive.start(request)
        workdir, temporary = self._workspace(request, archive.id)
        active_marker = workdir / ".mad-active" if temporary else None
        if active_marker:
            active_marker.write_text(archive.id, encoding="utf-8")
        transcript: list[Contribution] = []
        warnings: list[str] = []
        guidance: list[str] = []
        try:
            progress("正在预检参与者")
            preflight = await self._parallel(selected, "只回复 READY，不要执行任何工具。", workdir, Stage.OPENING, archive, preflight=True)
            healthy_ids = {item.agent_id for item in preflight}
            selected = [item for item in selected if item.id in healthy_ids]
            if len(selected) < 2:
                raise DeliberationError("预检后可用参与者不足两个")
            if report_agent not in selected:
                raise DeliberationError("报告 Agent 预检失败")

            phases = [
                (Stage.OPENING, "独立分析问题。明确结论、理由、假设、风险与资料来源，不参考其他参与者。"),
                (Stage.CRITIQUE, "阅读已有陈述，指出事实错误、遗漏、冲突和最强反例，并给出补充。"),
                (Stage.REVISION, "综合已有陈述、质疑和用户指导，提交你修订后的判断及其依据。"),
            ]
            for stage, instruction in phases:
                progress(f"开始阶段：{stage.value}")
                prompt = self._prompt(request, instruction, transcript, guidance)
                results = await self._parallel(selected, prompt, workdir, stage, archive)
                transcript.extend(results)
                if len(results) < 2:
                    raise DeliberationError(f"{stage.value}成功参与者不足两个")
                if checkpoint and stage in {Stage.OPENING, Stage.CRITIQUE}:
                    note = await checkpoint(stage, results)
                    if note:
                        guidance.append(note)

            draft_prompt = self._prompt(request, self._report_instruction(final=False), transcript, guidance)
            draft = await self._one(report_agent, draft_prompt, workdir, Stage.DRAFT, archive)
            transcript.append(draft)
            if checkpoint:
                note = await checkpoint(Stage.DRAFT, [draft])
                if note:
                    guidance.append(note)
            reviewers = [item for item in selected if item.id != report_agent.id]
            review_prompt = self._prompt(request, "只审阅报告草稿，列出事实错误、关键遗漏、证据不足和必须修改之处。", transcript, guidance)
            reviews = await self._parallel(reviewers, review_prompt, workdir, Stage.REVIEW, archive)
            transcript.extend(reviews)
            final_prompt = self._prompt(request, self._report_instruction(final=True), transcript, guidance)
            final = await self._one(report_agent, final_prompt, workdir, Stage.FINAL, archive)
            transcript.append(final)
            result = RunResult(archive.id, "完成" if not warnings else "带警告完成", final.text, archive.path, warnings, [p.id for p in selected])
            archive.finish(result)
            return result
        finally:
            if temporary:
                active_marker.unlink(missing_ok=True)
                shutil.rmtree(workdir, ignore_errors=True)

    def _profile(self, agent_id: str) -> AgentProfile:
        profile = self.profiles.get(agent_id)
        if not profile or not profile.enabled:
            raise DeliberationError(f"Agent 配置不可用：{agent_id}")
        return profile

    def _workspace(self, request: DeliberationRequest, archive_id: str) -> tuple[Path, bool]:
        if not request.workspace:
            target = self.home / "temp" / archive_id
            target.mkdir(parents=True, exist_ok=False)
            return target, True
        if request.direct_workspace:
            return request.workspace.expanduser().resolve(), False
        return create_snapshot(request.workspace, self.home / "temp" / archive_id), True

    async def _parallel(self, profiles, prompt, cwd, stage, archive, *, preflight=False):
        gathered = await asyncio.gather(
            *(self._one(profile, prompt, cwd, stage, archive, preflight=preflight) for profile in profiles),
            return_exceptions=True,
        )
        results = []
        for profile, item in zip(profiles, gathered, strict=True):
            if isinstance(item, Exception):
                archive.diagnostic({"stage": stage.value, "agent_id": profile.id, "error": str(item)})
            else:
                results.append(item)
        return results

    async def _one(self, profile, prompt, cwd, stage, archive, *, preflight=False):
        async with self.semaphore:
            last_error = None
            for attempt in (1, 2):
                try:
                    result = await self.adapter_factory(profile).invoke(prompt, cwd)
                    contribution = Contribution(stage, profile.id, profile.name, result.text, result.duration_seconds, attempt)
                    if not preflight:
                        archive.append(contribution)
                    return contribution
                except AdapterError as exc:
                    last_error = exc
            raise DeliberationError(f"{profile.name} 调用失败：{last_error}")

    @staticmethod
    def _prompt(request, instruction, transcript, guidance):
        history = "\n\n".join(f"[{item.stage.value} / {item.agent_name}]\n{item.text}" for item in transcript)
        notes = "\n".join(f"- {item}" for item in guidance) or "无"
        return f"""你正在参加一次只读结构化审议。不得修改文件或执行有副作用的操作。\n\n问题：\n{request.question}\n\n当前阶段要求：\n{instruction}\n\n用户指导：\n{notes}\n\n已有正式审议记录：\n{history or '暂无'}\n\n请只输出可公开给其他参与者的正式发言。"""

    @staticmethod
    def _report_instruction(*, final: bool) -> str:
        verb = "根据审阅意见修订并定稿" if final else "起草"
        return f"{verb}最终报告。必须包含执行摘要、明确结论、关键理由、分歧与不确定性、可核查来源或缺少来源的说明，以及下一步行动。"
