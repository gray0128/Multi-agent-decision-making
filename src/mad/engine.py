from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from pathlib import Path

from .adapters import AdapterError, CliAdapter, PreflightResult
from .archive import Archive
from .context import estimate_tokens
from .disputes import parse_dispute_list, parse_revision, raw_union
from .models import AgentProfile, CheckpointDecision, Contribution, DeliberationRequest, RunResult, Stage
from .snapshot import create_snapshot
from .state import DeliberationState


Checkpoint = Callable[[Stage, list[Contribution]], Awaitable[CheckpointDecision | str | None]]
Progress = Callable[[str], None]
PREFLIGHT_STAGE = "预检"
ACTIVE_MARKER = ".mad-active"
RECOVERABLE_MARKER = ".mad-recoverable"


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
        try:
            workdir, temporary = self._workspace(request, archive.id)
        except Exception as exc:
            archive.mark_status("失败", reason=str(exc))
            raise
        state = DeliberationState.create(
            archive.id,
            request,
            workdir,
            temporary_workspace=temporary,
        )
        archive.save_state(state)
        archive.replace_transcript([])
        return await self._execute(archive, state, checkpoint=checkpoint, progress=progress)

    async def resume(
        self,
        deliberation_id: str,
        *,
        checkpoint: Checkpoint | None = None,
        progress: Progress = lambda _: None,
    ) -> RunResult:
        archive = Archive.open(self.home, deliberation_id)
        state = archive.load_state()
        if state.status in {"完成", "带警告完成"}:
            raise DeliberationError(f"审议已经完成，不能恢复：{deliberation_id}")
        return await self._execute(archive, state, checkpoint=checkpoint, progress=progress)

    async def _execute(
        self,
        archive: Archive,
        state: DeliberationState,
        *,
        checkpoint: Checkpoint | None,
        progress: Progress,
    ) -> RunResult:
        request = state.to_request()
        workdir = Path(state.workdir)
        if not workdir.is_dir():
            raise DeliberationError(f"恢复所需工作目录或快照不存在：{workdir}")
        archive.replace_transcript(state.contributions())
        self._mark_active(state)
        state.status = "运行中"
        archive.save_state(state)
        archive.mark_status("运行中")
        completed = False
        try:
            selected, report_agent = await self._ensure_preflight(state, request, workdir, archive, progress)

            if state.pending_checkpoint:
                await self._resolve_pending_checkpoint(state, archive, checkpoint)

            if not state.stage_completed(Stage.OPENING):
                opening = await self._run_parallel_stage(
                    state,
                    archive,
                    selected,
                    request,
                    Stage.OPENING,
                    "独立分析问题。明确结论、理由、假设、风险与资料来源，不参考其他参与者。",
                    workdir,
                    progress,
                    context_profiles=selected,
                    summary_agent=report_agent,
                )
                await self._checkpoint_after_stage(state, archive, Stage.OPENING, opening, checkpoint)

            if not state.stage_completed(Stage.CRITIQUE):
                critique = await self._run_parallel_stage(
                    state,
                    archive,
                    selected,
                    request,
                    Stage.CRITIQUE,
                    "阅读已有陈述，指出事实错误、遗漏、冲突和最强反例，并给出补充。",
                    workdir,
                    progress,
                    context_profiles=selected,
                    summary_agent=report_agent,
                )
                await self._checkpoint_after_stage(state, archive, Stage.CRITIQUE, critique, checkpoint)

            if not state.stage_completed(Stage.REVISION):
                revision_instruction = """综合已有陈述、质疑和用户指导，提交修订后的判断及其依据。正文后必须附带一个 ```json 代码块，格式为：
{"has_critical_dispute": true或false, "disputes": [{"title": "具体争议", "impact": "为何实质改变最终结论"}]}。
没有关键未决争议时 disputes 必须为空。一般观点差异不得标记为关键争议。"""
                revisions = await self._run_parallel_stage(
                    state,
                    archive,
                    selected,
                    request,
                    Stage.REVISION,
                    revision_instruction,
                    workdir,
                    progress,
                    parse_revision_signal=True,
                    context_profiles=selected,
                    summary_agent=report_agent,
                )
            if not state.stage_completed(Stage.DISPUTE_DECISION):
                revisions = state.stage_items(Stage.REVISION)
                for item in revisions:
                    if warning := item.metadata.get("signal_warning"):
                        message = f"{item.agent_name}：{warning}"
                        if message not in state.warnings:
                            state.warnings.append(message)
                self._initialize_convergence(state, request, revisions)
                archive.save_state(state)
                await self._checkpoint_after_stage(
                    state,
                    archive,
                    Stage.DISPUTE_DECISION,
                    revisions,
                    checkpoint,
                )

            if state.convergence.get("triggered"):
                await self._run_convergence(
                    state,
                    archive,
                    selected,
                    report_agent,
                    request,
                    workdir,
                    progress,
                )

            if not state.stage_completed(Stage.DRAFT):
                draft = await self._run_single_stage(
                    state,
                    archive,
                    report_agent,
                    request,
                    Stage.DRAFT,
                    self._report_instruction(final=False),
                    workdir,
                    progress,
                    context_profiles=selected,
                    summary_agent=report_agent,
                )
                await self._checkpoint_after_stage(state, archive, Stage.DRAFT, [draft], checkpoint)

            if not state.stage_completed(Stage.REVIEW):
                reviewers = [item for item in selected if item.id != report_agent.id]
                await self._run_parallel_stage(
                    state,
                    archive,
                    reviewers,
                    request,
                    Stage.REVIEW,
                    "只审阅报告草稿，列出事实错误、关键遗漏、证据不足和必须修改之处。",
                    workdir,
                    progress,
                    minimum_success=1,
                    context_profiles=selected,
                    summary_agent=report_agent,
                )

            if not state.stage_completed(Stage.FINAL):
                await self._run_single_stage(
                    state,
                    archive,
                    report_agent,
                    request,
                    Stage.FINAL,
                    self._report_instruction(final=True),
                    workdir,
                    progress,
                    context_profiles=selected,
                    summary_agent=report_agent,
                )

            final_items = state.stage_items(Stage.FINAL)
            if len(final_items) != 1:
                raise DeliberationError("最终修订阶段缺少唯一可提交输出")
            result = RunResult(
                state.deliberation_id,
                "完成" if not state.warnings else "带警告完成",
                final_items[0].text,
                archive.path,
                list(state.warnings),
                list(state.participants),
                dict(state.convergence),
                self._plan_payload(state, request),
            )
            state.status = result.status
            state.active_stage = None
            state.pending_checkpoint = None
            archive.save_state(state)
            archive.finish(result)
            completed = True
            return result
        except DeliberationCancelled as exc:
            self._mark_recoverable(state, archive, str(exc), event_type="cancelled")
            raise
        except asyncio.CancelledError:
            self._mark_recoverable(state, archive, "审议任务已取消", event_type="cancelled")
            raise
        except Exception as exc:
            self._mark_recoverable(state, archive, str(exc), event_type="failed")
            raise
        finally:
            if completed and state.temporary_workspace:
                shutil.rmtree(workdir, ignore_errors=True)

    async def _ensure_preflight(self, state, request, workdir, archive, progress):
        if state.stage_completed(PREFLIGHT_STAGE):
            selected = [self._profile(agent_id) for agent_id in state.participants]
            for profile in selected:
                expected = state.profile_fingerprints.get(profile.id)
                if expected != asdict(profile):
                    raise DeliberationError(f"Agent 配置自上次运行后发生变化：{profile.id}")
            report_agent = self._profile(state.report_agent_id)
            if report_agent not in selected:
                raise DeliberationError("持久化状态中的报告 Agent 不在参与者中")
            archive.save_plan(self._plan_payload(state, request))
            return selected, report_agent

        selected = [self._profile(agent_id) for agent_id in request.agent_ids]
        report_agent = self._profile(request.report_agent_id)
        state.begin_stage(PREFLIGHT_STAGE)
        archive.save_state(state)
        progress("正在预检参与者")
        results = await asyncio.gather(
            *(self._preflight(profile, workdir, project_mode=request.workspace is not None) for profile in selected)
        )
        healthy_ids = set()
        failures = {}
        for profile, result in zip(selected, results, strict=True):
            archive.diagnostic({"kind": "preflight", "stage": PREFLIGHT_STAGE, "agent_id": profile.id, **result.to_dict()})
            if result.ready:
                healthy_ids.add(profile.id)
            else:
                failures[profile.id] = result.error or "未知预检失败"
        if failures:
            details = "；".join(f"{agent_id}: {error}" for agent_id, error in failures.items())
            raise DeliberationError(f"已确认审议方案中的参与者预检失败：{details}")
        selected = [profile for profile in selected if profile.id in healthy_ids]
        if len(selected) < 2:
            details = "；".join(f"{agent_id}: {error}" for agent_id, error in failures.items())
            raise DeliberationError(f"预检后可用参与者不足两个：{details}")
        if report_agent not in selected:
            raise DeliberationError(f"报告 Agent 预检失败：{failures.get(report_agent.id, '未知预检失败')}")
        state.participants = [profile.id for profile in selected]
        state.report_agent_id = report_agent.id
        state.profile_fingerprints = {profile.id: asdict(profile) for profile in selected}
        state.completed_stages.append(PREFLIGHT_STAGE)
        state.active_stage = None
        archive.save_state(state)
        archive.save_plan(self._plan_payload(state, request))
        archive.event({"type": "stage_committed", "stage": PREFLIGHT_STAGE, "participants": state.participants})
        return selected, report_agent

    @staticmethod
    def _plan_payload(state, request):
        return {
            "participants": [
                {"id": agent_id, "role": request.roles.get(agent_id, "")}
                for agent_id in state.participants
            ],
            "report_agent_id": state.report_agent_id,
            "organizer_agent_id": request.organizer_agent_id,
            "source": "organizer" if request.organizer_agent_id else "manual",
        }

    async def _run_parallel_stage(
        self,
        state,
        archive,
        profiles,
        request,
        stage,
        instruction,
        workdir,
        progress,
        *,
        parse_revision_signal=False,
        minimum_success=2,
        context_profiles,
        summary_agent,
    ):
        prompt = await self._stage_input(
            state,
            request,
            stage,
            instruction,
            context_profiles,
            summary_agent,
            workdir,
            archive,
        )
        state.begin_stage(stage, prompt)
        archive.save_state(state)
        progress(f"开始阶段：{stage.value}")
        results = await self._parallel(
            profiles,
            prompt,
            workdir,
            stage,
            archive,
            parse_revision_signal=parse_revision_signal,
            roles=request.roles,
        )
        if len(results) < minimum_success:
            self._record_partial_outputs(archive, stage, results, reason="成功参与者不足")
            raise DeliberationError(f"{stage.value}成功参与者不足{minimum_success}个")
        self._commit_stage(state, archive, stage, results)
        return results

    async def _run_single_stage(
        self,
        state,
        archive,
        profile,
        request,
        stage,
        instruction,
        workdir,
        progress,
        *,
        context_profiles,
        summary_agent,
    ):
        prompt = await self._stage_input(
            state,
            request,
            stage,
            instruction,
            context_profiles,
            summary_agent,
            workdir,
            archive,
        )
        state.begin_stage(stage, prompt)
        archive.save_state(state)
        progress(f"开始阶段：{stage.value}")
        result = await self._one(
            profile,
            self._with_role(prompt, request.roles.get(profile.id, "")),
            workdir,
            stage,
            archive,
        )
        self._commit_stage(state, archive, stage, [result])
        return result

    def _commit_stage(self, state, archive, stage, items):
        state.commit_stage(stage, items)
        archive.save_state(state)
        archive.replace_transcript(state.contributions())
        archive.event(
            {
                "type": "stage_committed",
                "stage": stage.value if isinstance(stage, Stage) else stage,
                "contribution_count": len(items),
            }
        )

    async def _stage_input(
        self,
        state,
        request,
        stage,
        instruction,
        context_profiles,
        summary_agent,
        workdir,
        archive,
    ):
        value = stage.value if isinstance(stage, Stage) else stage
        if state.active_stage == value and value in state.stage_inputs:
            return state.stage_inputs[value]
        prompt = self._prompt(
            request,
            instruction,
            state.contributions(),
            state.guidance,
            summary=state.summary,
        )
        estimates = self._budget_estimates(prompt, request.roles, context_profiles)
        if not self._over_budget(estimates, context_profiles):
            return prompt
        if not state.transcript:
            raise DeliberationError(f"{value}基础提示已超过参与者上下文预算，且没有可摘要的审议记录")
        state.begin_stage(stage)
        archive.save_state(state)
        target_tokens = max(32, min(profile.context_budget for profile in context_profiles) // 2)
        summary_prompt = self._summary_prompt(
            request,
            state.contributions(),
            state.guidance,
            target_tokens=target_tokens,
        )
        summary_input_tokens = estimate_tokens(
            self._with_role(summary_prompt, request.roles.get(summary_agent.id, ""))
        )
        if summary_input_tokens > summary_agent.context_budget:
            raise DeliberationError(
                f"统一审议摘要输入超过报告 Agent 上下文预算（{summary_input_tokens} > "
                f"{summary_agent.context_budget}），审议已暂停"
            )
        try:
            contribution = await self._one(
                summary_agent,
                self._with_role(summary_prompt, request.roles.get(summary_agent.id, "")),
                workdir,
                Stage.SUMMARY,
                archive,
            )
        except DeliberationError as exc:
            raise DeliberationError(f"统一审议摘要生成失败，审议已暂停：{exc}") from exc
        if not contribution.text.strip():
            raise DeliberationError("统一审议摘要为空，审议已暂停")
        state.summary = {
            "text": contribution.text,
            "through_count": len(state.transcript),
            "trigger_stage": value,
            "estimated_tokens_before": estimates,
            "summary_input_tokens": summary_input_tokens,
        }
        compact_prompt = self._prompt(
            request,
            instruction,
            state.contributions(),
            state.guidance,
            summary=state.summary,
        )
        compact_estimates = self._budget_estimates(compact_prompt, request.roles, context_profiles)
        state.summary["estimated_tokens_after"] = compact_estimates
        archive.save_state(state)
        archive.event(
            {
                "type": "context_summary",
                "stage": value,
                "through_count": len(state.transcript),
                "estimated_tokens_before": estimates,
                "estimated_tokens_after": compact_estimates,
                "summary_input_tokens": summary_input_tokens,
                "text": contribution.text,
            }
        )
        if self._over_budget(compact_estimates, context_profiles):
            raise DeliberationError("统一审议摘要生成后仍超过参与者上下文预算，审议已暂停")
        return compact_prompt

    def _budget_estimates(self, prompt, roles, profiles):
        return {
            profile.id: estimate_tokens(self._with_role(prompt, roles.get(profile.id, "")))
            for profile in profiles
        }

    @staticmethod
    def _over_budget(estimates, profiles):
        return any(estimates[profile.id] > profile.context_budget for profile in profiles)

    async def _checkpoint_after_stage(self, state, archive, stage, items, checkpoint):
        state.pending_checkpoint = stage.value
        archive.save_state(state)
        if checkpoint is None and state.request.get("interactive"):
            raise DeliberationError(f"审议正在等待{stage.value}检查点；恢复时必须启用交互模式")
        decision = await checkpoint(stage, items) if checkpoint else None
        self._apply_checkpoint_decision(state, archive, stage, decision)
        state.pending_checkpoint = None
        archive.save_state(state)

    async def _resolve_pending_checkpoint(self, state, archive, checkpoint):
        stage = Stage(state.pending_checkpoint)
        source_stage = Stage.REVISION if stage == Stage.DISPUTE_DECISION else stage
        items = state.stage_items(source_stage)
        if checkpoint is None:
            raise DeliberationError(f"审议正在等待{stage.value}检查点；恢复时必须启用交互模式")
        decision = await checkpoint(stage, items)
        self._apply_checkpoint_decision(state, archive, stage, decision)
        state.pending_checkpoint = None
        archive.save_state(state)

    def _apply_checkpoint_decision(self, state, archive, stage, decision):
        if isinstance(decision, CheckpointDecision):
            action = decision.action
            note = decision.guidance.strip()
        else:
            value = decision.strip() if isinstance(decision, str) else ""
            if stage == Stage.DISPUTE_DECISION and value == "/skip":
                action, note = "skip", ""
            elif stage == Stage.DISPUTE_DECISION and value.startswith("/trigger"):
                action, note = "trigger", value.removeprefix("/trigger").strip()
            else:
                action, note = "guidance" if value else "continue", value
        if action == "cancel":
            raise DeliberationCancelled("用户取消审议")
        if note:
            state.guidance.append(note)
            archive.event({"type": "user_guidance", "after_stage": stage.value, "text": note})
        if stage == Stage.DISPUTE_DECISION:
            if action == "skip":
                state.convergence["triggered"] = False
                state.convergence["reason"] = "用户跳过"
                archive.event({"type": "dispute_override", "action": "skip", "stage": stage.value})
            elif action == "trigger":
                state.convergence["triggered"] = True
                state.convergence["reason"] = "用户强制触发"
                archive.event({"type": "dispute_override", "action": "trigger", "stage": stage.value})
            elif action not in {"continue", "guidance"}:
                raise DeliberationError(f"争议判定检查点不支持动作：{action}")
            if not state.stage_completed(Stage.DISPUTE_DECISION):
                state.completed_stages.append(Stage.DISPUTE_DECISION.value)
        elif action not in {"continue", "guidance"}:
            raise DeliberationError(f"{stage.value}检查点不支持动作：{action}")

    def _initialize_convergence(self, state, request, revisions):
        signals = [
            (item.agent_id, item.metadata["dispute_signal"])
            for item in revisions
            if item.metadata.get("dispute_signal")
        ]
        marked_count = sum(1 for _, signal in signals if signal.get("has_critical_dispute"))
        strategy = request.convergence
        if strategy not in {"auto", "always", "never"}:
            raise DeliberationError(f"未知争议收敛策略：{strategy}")
        triggered = strategy == "always" or (strategy == "auto" and marked_count >= 2)
        reason = "阈值未满足"
        if strategy == "always":
            reason = "策略强制触发"
        elif triggered:
            reason = "至少两名参与者标记关键争议"
        elif strategy == "never":
            triggered = False
            reason = "策略禁止触发"
        state.convergence.update(
            {
                "strategy": strategy,
                "triggered": triggered,
                "reason": reason,
                "marked_participants": marked_count,
            }
        )

    async def _run_convergence(self, state, archive, selected, report_agent, request, workdir, progress):
        revisions = state.stage_items(Stage.REVISION)
        signals = [
            (item.agent_id, item.metadata["dispute_signal"])
            for item in revisions
            if item.metadata.get("dispute_signal") and item.metadata["dispute_signal"].get("has_critical_dispute")
        ]
        raw_disputes = raw_union(signals)
        if not state.stage_completed(Stage.DISPUTE_ORGANIZATION):
            organization_prompt = await self._stage_input(
                state,
                request,
                Stage.DISPUTE_ORGANIZATION,
                self._dispute_organization_instruction(raw_disputes, request.convergence),
                selected,
                report_agent,
                workdir,
                archive,
            )
            state.begin_stage(Stage.DISPUTE_ORGANIZATION, organization_prompt)
            archive.save_state(state)
            progress("正在整理关键未决争议")
            organized = None
            try:
                organized = await self._one(
                    report_agent,
                    self._with_role(organization_prompt, request.roles.get(report_agent.id, "")),
                    workdir,
                    Stage.DISPUTE_ORGANIZATION,
                    archive,
                )
            except DeliberationError as exc:
                state.warnings.append(f"争议整理失败，使用原始并集：{exc}")
            disputes = parse_dispute_list(organized.text) if organized else []
            if not disputes:
                disputes = raw_disputes
            state.convergence["disputes"] = disputes
            self._commit_stage(
                state,
                archive,
                Stage.DISPUTE_ORGANIZATION,
                [organized] if organized else [],
            )
        disputes = list(state.convergence.get("disputes", []))
        if not disputes:
            state.warnings.append("已请求争议收敛，但无法形成具体争议清单，已跳过")
            state.convergence["status"] = "无具体争议，已跳过"
            if not state.stage_completed(Stage.CONVERGENCE):
                self._commit_stage(state, archive, Stage.CONVERGENCE, [])
            return
        if not state.stage_completed(Stage.CONVERGENCE):
            convergence = await self._run_parallel_stage(
                state,
                archive,
                selected,
                request,
                Stage.CONVERGENCE,
                self._convergence_instruction(disputes),
                workdir,
                progress,
                minimum_success=1,
                context_profiles=selected,
                summary_agent=report_agent,
            )
        if state.stage_completed(Stage.CONVERGENCE):
            convergence = state.stage_items(Stage.CONVERGENCE)
            warning = "争议收敛轮成功参与者不足两名；所有争议保持未解决"
            if len(convergence) < 2:
                if warning not in state.warnings:
                    state.warnings.append(warning)
                state.convergence["status"] = "参与者不足，争议未解决"
            else:
                state.convergence["status"] = "已完成"
            archive.save_state(state)

    def _mark_active(self, state: DeliberationState) -> None:
        if not state.temporary_workspace:
            return
        workdir = Path(state.workdir)
        (workdir / RECOVERABLE_MARKER).unlink(missing_ok=True)
        (workdir / ACTIVE_MARKER).write_text(state.deliberation_id, encoding="utf-8")

    def _mark_recoverable(self, state, archive, reason, *, event_type):
        state.status = "可恢复"
        archive.save_state(state)
        archive.mark_status("可恢复", reason=reason)
        archive.event({"type": event_type, "reason": reason, "active_stage": state.active_stage})
        if state.temporary_workspace:
            workdir = Path(state.workdir)
            if workdir.is_dir():
                (workdir / ACTIVE_MARKER).unlink(missing_ok=True)
                (workdir / RECOVERABLE_MARKER).write_text(state.deliberation_id, encoding="utf-8")

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

    async def _parallel(
        self,
        profiles,
        prompt,
        cwd,
        stage,
        archive,
        *,
        parse_revision_signal=False,
        roles=None,
    ):
        roles = roles or {}
        tasks = [
            asyncio.create_task(
                self._one(
                    profile,
                    self._with_role(prompt, roles.get(profile.id, "")),
                    cwd,
                    stage,
                    archive,
                    parse_revision_signal=parse_revision_signal,
                )
            )
            for profile in profiles
        ]
        try:
            gathered = await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            partial = []
            for task in tasks:
                if task.done() and not task.cancelled():
                    try:
                        item = task.result()
                    except Exception:
                        continue
                    if isinstance(item, Contribution):
                        partial.append(item)
                elif not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._record_partial_outputs(archive, stage, partial, reason="阶段取消")
            raise
        results = []
        for profile, item in zip(profiles, gathered, strict=True):
            if isinstance(item, BaseException):
                archive.diagnostic(
                    {"kind": "call_error", "stage": stage.value, "agent_id": profile.id, "error": str(item)}
                )
            else:
                results.append(item)
        return results

    @staticmethod
    def _with_role(prompt: str, role: str) -> str:
        role = role.strip()
        return f"{prompt}\n\n你的本次临时角色：\n{role}" if role else prompt

    @staticmethod
    def _record_partial_outputs(archive, stage, items, *, reason):
        for item in items:
            archive.diagnostic(
                {
                    "kind": "partial_stage_output",
                    "stage": stage.value,
                    "reason": reason,
                    "contribution": item.to_dict(),
                }
            )

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
                    return Contribution(
                        stage, profile.id, profile.name, text, result.duration_seconds, attempt, metadata
                    )
                except AdapterError as exc:
                    last_error = exc
            raise DeliberationError(f"{profile.name} 调用失败：{last_error}")

    @staticmethod
    def _prompt(request, instruction, transcript, guidance, *, summary=None):
        if summary and summary.get("text"):
            through = min(int(summary.get("through_count", 0)), len(transcript))
            incremental = "\n\n".join(
                f"[{item.stage.value} / {item.agent_name}]\n{item.text}" for item in transcript[through:]
            )
            history = f"[统一审议摘要，覆盖前 {through} 条正式记录]\n{summary['text']}"
            if incremental:
                history += f"\n\n[摘要后的正式记录]\n{incremental}"
        else:
            history = "\n\n".join(
                f"[{item.stage.value} / {item.agent_name}]\n{item.text}" for item in transcript
            )
        notes = "\n".join(f"- {item}" for item in guidance) or "无"
        return f"""你正在参加一次只读结构化审议。不得修改文件或执行有副作用的操作。\n\n问题：\n{request.question}\n\n当前阶段要求：\n{instruction}\n\n用户指导：\n{notes}\n\n已有正式审议记录：\n{history or '暂无'}\n\n请只输出可公开给其他参与者的正式发言。"""

    @staticmethod
    def _summary_prompt(request, transcript, guidance, *, target_tokens):
        history = "\n\n".join(
            f"[{item.stage.value} / {item.agent_name} / {item.agent_id}]\n{item.text}" for item in transcript
        )
        notes = "\n".join(f"- {item}" for item in guidance) or "无"
        return f"""你是报告 Agent。请把以下权威完整审议记录压缩成一份供所有后续参与者共同使用的统一审议摘要，目标不超过约 {target_tokens} tokens。摘要必须忠实保留：原问题、全部用户指导、关键论点及其提出者、未决与已解决争议、关键假设、风险、不确定性，以及原文中出现的可核查来源。不得新增事实、裁决争议或省略相互冲突的结论。

原问题：
{request.question}

全部用户指导：
{notes}

权威完整审议记录：
{history}

只输出摘要正文。"""

    @staticmethod
    def _report_instruction(*, final: bool) -> str:
        verb = "根据审阅意见修订并定稿" if final else "起草"
        return f"{verb}最终报告。必须包含执行摘要、明确结论、关键理由、分歧与不确定性、可核查来源或缺少来源的说明，以及下一步行动。若存在争议收敛材料，逐项忠实归类为已解决、条件性一致或仍未解决，不得按多数投票决定。"

    @staticmethod
    def _dispute_organization_instruction(raw_disputes, strategy):
        return f"""你是报告 Agent，只负责整理争议，无权否决触发；请根据审议上下文完成整理。
原始争议信号：\n{json.dumps(raw_disputes, ensure_ascii=False)}
策略：{strategy}。合并语义相同项，不得删除任何原始信号；若 always 模式没有信号，可从修订意见提出带来源的具体候选争议。
只输出一个 ```json 代码块：{{"disputes":[{{"id":"D1","title":"中性标题","description":"争议为何影响结论","sources":["agent-id"]}}]}}。"""

    @staticmethod
    def _convergence_instruction(disputes):
        return f"""只处理以下关键未决争议，不要重新概括整个问题：
{json.dumps(disputes, ensure_ascii=False, indent=2)}
逐项给出最终立场、关键证据、对最强反方观点的回应、改变立场所需条件和仍无法消除的不确定性。新发现的问题只能列为新增风险，不能要求新增讨论轮次。"""
