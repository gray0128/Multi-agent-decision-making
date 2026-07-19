from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path

from .adapters import AdapterError, CliAdapter, PreflightResult
from .archive import Archive
from .disputes import parse_dispute_list, parse_revision, raw_union
from .models import AgentProfile, CheckpointDecision, Contribution, DeliberationRequest, RunResult, Stage
from .snapshot import create_snapshot


Checkpoint = Callable[[Stage, list[Contribution]], Awaitable[CheckpointDecision | str | None]]
Progress = Callable[[str], None]


class DeliberationError(RuntimeError):
    pass


class DeliberationCancelled(DeliberationError):
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
        deliberation_id: str | None = None,
    ) -> RunResult:
        selected = [self._profile(agent_id) for agent_id in request.agent_ids]
        if len(selected) < 2:
            raise DeliberationError("一次审议至少需要两个参与者")
        report_agent = self._profile(request.report_agent_id)
        if report_agent not in selected:
            raise DeliberationError("报告 Agent 必须是参与者")
        archive = Archive(self.home, archive_id=deliberation_id)
        archive.start(request)
        workdir, temporary = self._workspace(request, archive.id)
        active_marker = workdir / ".mad-active" if temporary else None
        if active_marker:
            active_marker.write_text(archive.id, encoding="utf-8")
        transcript: list[Contribution] = []
        warnings: list[str] = []
        guidance: list[str] = []
        convergence_info = {"strategy": request.convergence, "triggered": False, "reason": "阈值未满足", "marked_participants": 0, "disputes": [], "status": "未触发"}
        try:
            progress("正在预检参与者")
            preflight = await asyncio.gather(
                *(self._preflight(profile, workdir, project_mode=request.workspace is not None) for profile in selected)
            )
            healthy_ids = set()
            preflight_errors = {}
            for profile, result in zip(selected, preflight, strict=True):
                archive.diagnostic({"stage": "预检", "agent_id": profile.id, **result.to_dict()})
                if result.ready:
                    healthy_ids.add(profile.id)
                else:
                    preflight_errors[profile.id] = result.error or "未知预检失败"
            selected = [item for item in selected if item.id in healthy_ids]
            if len(selected) < 2:
                details = "；".join(f"{agent_id}: {error}" for agent_id, error in preflight_errors.items())
                raise DeliberationError(f"预检后可用参与者不足两个：{details}")
            if report_agent not in selected:
                raise DeliberationError(
                    f"报告 Agent 预检失败：{preflight_errors.get(report_agent.id, '未知预检失败')}"
                )

            phases = [
                (Stage.OPENING, "独立分析问题。明确结论、理由、假设、风险与资料来源，不参考其他参与者。"),
                (Stage.CRITIQUE, "阅读已有陈述，指出事实错误、遗漏、冲突和最强反例，并给出补充。"),
            ]
            for stage, instruction in phases:
                progress(f"开始阶段：{stage.value}")
                prompt = self._prompt(request, instruction, transcript, guidance)
                results = await self._parallel(selected, prompt, workdir, stage, archive)
                transcript.extend(results)
                if len(results) < 2:
                    raise DeliberationError(f"{stage.value}成功参与者不足两个")
                if checkpoint and stage in {Stage.OPENING, Stage.CRITIQUE}:
                    decision = await checkpoint(stage, results)
                    self._apply_standard_checkpoint(decision, stage, guidance, archive)

            progress(f"开始阶段：{Stage.REVISION.value}")
            revision_instruction = """综合已有陈述、质疑和用户指导，提交修订后的判断及其依据。正文后必须附带一个 ```json 代码块，格式为：
{"has_critical_dispute": true或false, "disputes": [{"title": "具体争议", "impact": "为何实质改变最终结论"}]}。
没有关键未决争议时 disputes 必须为空。一般观点差异不得标记为关键争议。"""
            revisions = await self._parallel(
                selected,
                self._prompt(request, revision_instruction, transcript, guidance),
                workdir,
                Stage.REVISION,
                archive,
                parse_revision_signal=True,
            )
            transcript.extend(revisions)
            if len(revisions) < 2:
                raise DeliberationError("修订意见成功参与者不足两个")
            for item in revisions:
                if warning := item.metadata.get("signal_warning"):
                    warnings.append(f"{item.agent_name}：{warning}")

            signals = [
                (item.agent_id, item.metadata["dispute_signal"])
                for item in revisions
                if item.metadata.get("dispute_signal")
            ]
            marked_count = sum(1 for _, signal in signals if signal.get("has_critical_dispute"))
            convergence_info["marked_participants"] = marked_count
            strategy = request.convergence
            if strategy not in {"auto", "always", "never"}:
                raise DeliberationError(f"未知争议收敛策略：{strategy}")
            should_converge = strategy == "always" or (strategy == "auto" and marked_count >= 2)
            if strategy == "always":
                convergence_info["reason"] = "策略强制触发"
            elif should_converge:
                convergence_info["reason"] = "至少两名参与者标记关键争议"
            if strategy == "never":
                should_converge = False
                convergence_info["reason"] = "策略禁止触发"
            if checkpoint:
                decision = await checkpoint(Stage.DISPUTE_DECISION, revisions)
                if isinstance(decision, CheckpointDecision):
                    if decision.action == "cancel":
                        raise DeliberationCancelled("用户取消审议")
                    note = decision.guidance.strip()
                    if note:
                        guidance.append(note)
                        archive.event(
                            {"type": "user_guidance", "after_stage": Stage.DISPUTE_DECISION.value, "text": note}
                        )
                    if decision.action == "skip":
                        should_converge = False
                        convergence_info["reason"] = "用户跳过"
                        archive.event(
                            {"type": "dispute_override", "action": "skip", "stage": Stage.DISPUTE_DECISION.value}
                        )
                    elif decision.action == "trigger":
                        should_converge = True
                        convergence_info["reason"] = "用户强制触发"
                        archive.event(
                            {"type": "dispute_override", "action": "trigger", "stage": Stage.DISPUTE_DECISION.value}
                        )
                    elif decision.action not in {"continue", "guidance"}:
                        raise DeliberationError(f"争议判定检查点不支持动作：{decision.action}")
                elif decision == "/skip":
                    should_converge = False
                    convergence_info["reason"] = "用户跳过"
                    archive.event(
                        {"type": "dispute_override", "action": "skip", "stage": Stage.DISPUTE_DECISION.value}
                    )
                elif decision and decision.startswith("/trigger"):
                    should_converge = True
                    convergence_info["reason"] = "用户强制触发"
                    archive.event(
                        {"type": "dispute_override", "action": "trigger", "stage": Stage.DISPUTE_DECISION.value}
                    )
                    extra = decision.removeprefix("/trigger").strip()
                    if extra:
                        guidance.append(extra)
                        archive.event(
                            {
                                "type": "user_guidance",
                                "after_stage": Stage.DISPUTE_DECISION.value,
                                "text": extra,
                            }
                        )
            convergence_info["triggered"] = should_converge

            disputes = []
            if should_converge:
                progress("正在整理关键未决争议")
                raw_disputes = raw_union([(agent, signal) for agent, signal in signals if signal.get("has_critical_dispute")])
                organization_prompt = self._dispute_organization_prompt(request, transcript, raw_disputes, strategy)
                try:
                    organized = await self._one(
                        report_agent, organization_prompt, workdir, Stage.DISPUTE_ORGANIZATION, archive
                    )
                    transcript.append(organized)
                    disputes = parse_dispute_list(organized.text)
                except DeliberationError as exc:
                    warnings.append(f"争议整理失败，使用原始并集：{exc}")
                if not disputes:
                    disputes = raw_disputes
                if not disputes:
                    warnings.append("已请求争议收敛，但无法形成具体争议清单，已跳过")
                    convergence_info["status"] = "无具体争议，已跳过"
                else:
                    convergence_info["disputes"] = disputes
                    progress(f"开始阶段：{Stage.CONVERGENCE.value}")
                    convergence_prompt = self._prompt(
                        request, self._convergence_instruction(disputes), transcript, guidance
                    )
                    convergence = await self._parallel(
                        selected, convergence_prompt, workdir, Stage.CONVERGENCE, archive
                    )
                    transcript.extend(convergence)
                    if len(convergence) < 2:
                        warnings.append("争议收敛轮成功参与者不足两名；所有争议保持未解决")
                        convergence_info["status"] = "参与者不足，争议未解决"
                    else:
                        convergence_info["status"] = "已完成"

            draft_prompt = self._prompt(request, self._report_instruction(final=False), transcript, guidance)
            draft = await self._one(report_agent, draft_prompt, workdir, Stage.DRAFT, archive)
            transcript.append(draft)
            if checkpoint:
                decision = await checkpoint(Stage.DRAFT, [draft])
                self._apply_standard_checkpoint(decision, Stage.DRAFT, guidance, archive)
            reviewers = [item for item in selected if item.id != report_agent.id]
            review_prompt = self._prompt(request, "只审阅报告草稿，列出事实错误、关键遗漏、证据不足和必须修改之处。", transcript, guidance)
            reviews = await self._parallel(reviewers, review_prompt, workdir, Stage.REVIEW, archive)
            transcript.extend(reviews)
            final_prompt = self._prompt(request, self._report_instruction(final=True), transcript, guidance)
            final = await self._one(report_agent, final_prompt, workdir, Stage.FINAL, archive)
            transcript.append(final)
            result = RunResult(
                archive.id,
                "完成" if not warnings else "带警告完成",
                final.text,
                archive.path,
                warnings,
                [p.id for p in selected],
                convergence_info,
            )
            archive.finish(result)
            return result
        except DeliberationCancelled as exc:
            archive.event({"type": "cancelled", "reason": str(exc)})
            archive.mark_status("已取消", reason=str(exc))
            raise
        except asyncio.CancelledError:
            archive.event({"type": "cancelled", "reason": "审议任务已取消"})
            archive.mark_status("已取消", reason="审议任务已取消")
            raise
        except Exception as exc:
            archive.event({"type": "failed", "error": str(exc)})
            archive.mark_status("失败", reason=str(exc))
            raise
        finally:
            if temporary:
                active_marker.unlink(missing_ok=True)
                shutil.rmtree(workdir, ignore_errors=True)

    def _profile(self, agent_id: str) -> AgentProfile:
        profile = self.profiles.get(agent_id)
        if not profile or not profile.enabled:
            raise DeliberationError(f"Agent 配置不可用：{agent_id}")
        return profile

    @staticmethod
    def _apply_standard_checkpoint(decision, stage, guidance, archive):
        if isinstance(decision, CheckpointDecision):
            if decision.action == "cancel":
                raise DeliberationCancelled("用户取消审议")
            if decision.action not in {"continue", "guidance"}:
                raise DeliberationError(f"{stage.value}检查点不支持动作：{decision.action}")
            note = decision.guidance.strip()
        else:
            note = decision.strip() if isinstance(decision, str) else ""
        if note:
            guidance.append(note)
            archive.event({"type": "user_guidance", "after_stage": stage.value, "text": note})

    def _workspace(self, request: DeliberationRequest, archive_id: str) -> tuple[Path, bool]:
        if not request.workspace:
            target = self.home / "temp" / archive_id
            target.mkdir(parents=True, exist_ok=False)
            return target, True
        if request.direct_workspace:
            return request.workspace.expanduser().resolve(), False
        return create_snapshot(request.workspace, self.home / "temp" / archive_id), True

    async def _parallel(self, profiles, prompt, cwd, stage, archive, *, parse_revision_signal=False):
        gathered = await asyncio.gather(
            *(
                self._one(
                    profile,
                    prompt,
                    cwd,
                    stage,
                    archive,
                    parse_revision_signal=parse_revision_signal,
                )
                for profile in profiles
            ),
            return_exceptions=True,
        )
        results = []
        for profile, item in zip(profiles, gathered, strict=True):
            if isinstance(item, Exception):
                archive.diagnostic({"stage": stage.value, "agent_id": profile.id, "error": str(item)})
            else:
                results.append(item)
        return results

    async def _preflight(self, profile, cwd, *, project_mode):
        adapter = self.adapter_factory(profile)
        preflight = getattr(adapter, "preflight", None)
        if preflight:
            return await preflight(cwd, project_mode=project_mode)
        try:
            await adapter.invoke("只回复 READY，不要执行任何工具。", cwd)
        except AdapterError as exc:
            return PreflightResult(True, False, True, 0, str(exc))
        return PreflightResult(True, True, True, 0)

    async def _one(self, profile, prompt, cwd, stage, archive, *, parse_revision_signal=False):
        async with self.semaphore:
            last_error = None
            for attempt in (1, 2):
                try:
                    result = await self.adapter_factory(profile).invoke(prompt, cwd)
                    text = result.text
                    metadata = {}
                    if parse_revision_signal:
                        parsed = parse_revision(text)
                        text = parsed.public_text
                        metadata["dispute_signal"] = parsed.signal
                        if parsed.warning:
                            metadata["signal_warning"] = parsed.warning
                    contribution = Contribution(
                        stage, profile.id, profile.name, text, result.duration_seconds, attempt, metadata
                    )
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
        return f"{verb}最终报告。必须包含执行摘要、明确结论、关键理由、分歧与不确定性、可核查来源或缺少来源的说明，以及下一步行动。若存在争议收敛材料，逐项忠实归类为已解决、条件性一致或仍未解决，不得按多数投票决定。"

    @staticmethod
    def _dispute_organization_prompt(request, transcript, raw_disputes, strategy):
        history = "\n\n".join(f"[{item.agent_name}] {item.text}" for item in transcript if item.stage == Stage.REVISION)
        return f"""你是报告 Agent，只负责整理争议，无权否决触发。问题：{request.question}
修订意见：\n{history}
原始争议信号：\n{json.dumps(raw_disputes, ensure_ascii=False)}
策略：{strategy}。合并语义相同项，不得删除任何原始信号；若 always 模式没有信号，可从修订意见提出带来源的具体候选争议。
只输出一个 ```json 代码块：{{"disputes":[{{"id":"D1","title":"中性标题","description":"争议为何影响结论","sources":["agent-id"]}}]}}。"""

    @staticmethod
    def _convergence_instruction(disputes):
        return f"""只处理以下关键未决争议，不要重新概括整个问题：
{json.dumps(disputes, ensure_ascii=False, indent=2)}
逐项给出最终立场、关键证据、对最强反方观点的回应、改变立场所需条件和仍无法消除的不确定性。新发现的问题只能列为新增风险，不能要求新增讨论轮次。"""
