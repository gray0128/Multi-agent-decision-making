from __future__ import annotations

import asyncio
import os
import secrets
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from uuid import uuid4

from agent_framework import Executor, WorkflowBuilder, WorkflowContext, WorkflowEvent, handler, response_handler
from pydantic import TypeAdapter

from .archive import Archive
from .config import app_home, load_agents
from .engine import DeliberationCancelled, DeliberationEngine
from .models import CheckpointDecision, Contribution, DeliberationRequest, RunResult, Stage
from .planning import DeliberationPlan, OrganizerService, PlanError, manual_plan, parse_plan_payload


class _DevUiSchemaModel:
    @classmethod
    def model_json_schema(cls) -> dict[str, Any]:
        return TypeAdapter(cls).json_schema()


@dataclass
class DevUiRequest(_DevUiSchemaModel):
    question: str = ""
    agents: list[str] = field(default_factory=list)
    report_agent: str = ""
    workspace: str = ""
    direct_workspace: bool = False
    convergence: str = "auto"
    interactive: bool = True
    resume_id: str = ""
    organizer: str = ""
    roles: dict[str, str] = field(default_factory=dict)


@dataclass
class DevUiPlanRequest(_DevUiSchemaModel):
    deliberation_id: str
    interrupt_id: str
    plan: dict[str, Any]
    available_agents: list[dict[str, str]]


@dataclass
class DevUiPlanResponse(_DevUiSchemaModel):
    deliberation_id: str
    interrupt_id: str
    action: str = "confirm"
    participants: list[dict[str, str]] = field(default_factory=list)
    report_agent_id: str = ""


@dataclass
class DevUiCheckpointRequest(_DevUiSchemaModel):
    deliberation_id: str
    interrupt_id: str
    stage: str
    actions: list[str]
    participants: list[dict[str, Any]]
    threshold: int | None = None
    disputes: list[dict[str, Any]] = field(default_factory=list)
    recommended_action: str = "continue"


@dataclass
class DevUiCheckpointResponse(_DevUiSchemaModel):
    deliberation_id: str
    interrupt_id: str
    action: str = "continue"
    guidance: str = ""


@dataclass(slots=True)
class _CancelledBoundary:
    reason: str


@dataclass(slots=True)
class _ErrorBoundary:
    error: Exception


@dataclass(slots=True)
class _PendingPlan:
    request: DevUiRequest
    plan_request: DevUiPlanRequest
    allowed_ids: set[str]


class _LiveSession:
    def __init__(
        self,
        engine: DeliberationEngine,
        request: DeliberationRequest,
        deliberation_id: str,
        *,
        interactive: bool,
        resume_existing: bool = False,
    ):
        self.engine = engine
        self.request = request
        self.deliberation_id = deliberation_id
        self.interactive = interactive
        self.resume_existing = resume_existing
        self.boundaries: asyncio.Queue[DevUiCheckpointRequest | RunResult | _CancelledBoundary | _ErrorBoundary] = (
            asyncio.Queue()
        )
        self.pending_request: DevUiCheckpointRequest | None = None
        self.pending_future: asyncio.Future[CheckpointDecision] | None = None
        self.task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self.task is not None:
            raise RuntimeError("审议会话已经启动")
        self.task = asyncio.create_task(self._drive())

    async def _drive(self) -> None:
        try:
            options = {"checkpoint": self._checkpoint if self.interactive else None}
            if self.resume_existing:
                result = await self.engine.resume(self.deliberation_id, **options)
            else:
                result = await self.engine.run(self.request, deliberation_id=self.deliberation_id, **options)
        except DeliberationCancelled as exc:
            await self.boundaries.put(_CancelledBoundary(str(exc)))
        except asyncio.CancelledError:
            await self.boundaries.put(_CancelledBoundary("审议任务已取消"))
            raise
        except Exception as exc:
            await self.boundaries.put(_ErrorBoundary(exc))
        else:
            await self.boundaries.put(result)

    async def _checkpoint(self, stage: Stage, items: list[Contribution]) -> CheckpointDecision:
        if self.pending_future is not None:
            raise RuntimeError("审议会话已有待处理检查点")
        request = self._checkpoint_request(stage, items)
        future: asyncio.Future[CheckpointDecision] = asyncio.get_running_loop().create_future()
        self.pending_request = request
        self.pending_future = future
        await self.boundaries.put(request)
        try:
            return await future
        finally:
            if self.pending_future is future:
                self.pending_request = None
                self.pending_future = None

    def _checkpoint_request(self, stage: Stage, items: list[Contribution]) -> DevUiCheckpointRequest:
        interrupt_id = str(uuid4())
        participants = []
        disputes = []
        marked = 0
        for item in items:
            signal = item.metadata.get("dispute_signal")
            participant = {"agent_id": item.agent_id, "agent_name": item.agent_name}
            if stage == Stage.DISPUTE_DECISION:
                participant.update(
                    {
                        "signal_valid": signal is not None,
                        "has_critical_dispute": bool(signal and signal.get("has_critical_dispute")),
                        "disputes": list(signal.get("disputes", [])) if signal else [],
                    }
                )
                if participant["has_critical_dispute"]:
                    marked += 1
                for value in participant["disputes"]:
                    disputes.append(
                        {
                            "source_agent_id": item.agent_id,
                            "title": value.get("title", ""),
                            "impact": value.get("impact", ""),
                        }
                    )
            participants.append(participant)
        if stage == Stage.DISPUTE_DECISION:
            actions = ["continue", "guidance", "trigger", "skip", "cancel"]
            threshold = 2
            recommended = "trigger" if marked >= threshold else "skip"
        else:
            actions = ["continue", "guidance", "cancel"]
            threshold = None
            recommended = "continue"
        return DevUiCheckpointRequest(
            deliberation_id=self.deliberation_id,
            interrupt_id=interrupt_id,
            stage=stage.value,
            actions=actions,
            participants=participants,
            threshold=threshold,
            disputes=disputes,
            recommended_action=recommended,
        )

    def validate_response(
        self,
        original_request: DevUiCheckpointRequest,
        response: DevUiCheckpointResponse,
        workflow_request_id: str | None,
    ) -> str | None:
        pending = self.pending_request
        if pending is None or self.pending_future is None or self.pending_future.done():
            return "检查点已过期或已经处理"
        if original_request.interrupt_id != pending.interrupt_id:
            return "原始中断 ID 与当前检查点不匹配"
        if workflow_request_id != pending.interrupt_id:
            return "Workflow request ID 与当前中断 ID 不匹配"
        if response.deliberation_id != self.deliberation_id:
            return "响应的审议 ID 不匹配"
        if response.interrupt_id != pending.interrupt_id:
            return "响应的中断 ID 不匹配"
        if response.action not in pending.actions:
            return f"当前检查点不支持动作：{response.action}"
        if response.action == "guidance" and not response.guidance.strip():
            return "添加指导动作必须提供非空指导意见"
        return None

    def resume(self, response: DevUiCheckpointResponse) -> None:
        if self.pending_future is None or self.pending_future.done():
            raise RuntimeError("检查点已过期或已经处理")
        self.pending_future.set_result(
            CheckpointDecision(action=response.action, guidance=response.guidance.strip())
        )

    def rotate_interrupt(self) -> DevUiCheckpointRequest:
        if self.pending_request is None or self.pending_future is None or self.pending_future.done():
            raise RuntimeError("检查点已过期或已经处理")
        self.pending_request = replace(self.pending_request, interrupt_id=str(uuid4()))
        return self.pending_request

    async def close(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass


class DeliberationExecutor(Executor):
    def __init__(self, engine: DeliberationEngine):
        super().__init__("structured-deliberation")
        self.engine = engine
        self.sessions: dict[str, _LiveSession] = {}
        self.pending_plans: dict[str, _PendingPlan] = {}

    @handler
    async def deliberate(self, request: DevUiRequest, ctx: WorkflowContext[None, str]) -> None:
        if request.resume_id:
            if request.resume_id in self.sessions:
                raise ValueError(f"审议仍在当前进程中运行：{request.resume_id}")
            state = Archive.open(self.engine.home, request.resume_id).load_state()
            session = _LiveSession(
                self.engine,
                state.to_request(),
                request.resume_id,
                interactive=request.interactive,
                resume_existing=True,
            )
            self.sessions[request.resume_id] = session
            session.start()
            try:
                await self._emit_next_boundary(session, ctx)
            except asyncio.CancelledError:
                self.sessions.pop(request.resume_id, None)
                await session.close()
                raise
            return
        profiles = list(self.engine.profiles.values())
        planning_cwd = Path(request.workspace).expanduser().resolve() if request.workspace else self.engine.home
        planner = OrganizerService(profiles, adapter_factory=self.engine.adapter_factory)
        healthy = await planner.preflight(planning_cwd, project_mode=bool(request.workspace))
        if len(healthy) < 2:
            raise ValueError("预检后可用参与者不足两个")
        allowed_ids = {item.id for item in healthy}
        requested_agents = list(dict.fromkeys(request.agents))
        try:
            if request.organizer:
                suggested = await planner.propose(request.question, request.organizer, healthy, planning_cwd)
                agents = requested_agents or suggested.agent_ids
                roles = {agent_id: suggested.roles.get(agent_id, "") for agent_id in agents}
                roles.update(request.roles)
                report = request.report_agent or suggested.report_agent_id
                plan = manual_plan(
                    profiles,
                    agents,
                    report,
                    roles,
                    allowed_ids=allowed_ids,
                    organizer_agent_id=request.organizer,
                )
            else:
                agents = requested_agents or [item.id for item in healthy]
                report = request.report_agent or next(
                    (item.id for item in healthy if item.default_report), agents[0]
                )
                plan = manual_plan(profiles, agents, report, request.roles, allowed_ids=allowed_ids)
        except PlanError as exc:
            raise ValueError(str(exc)) from exc
        deliberation_id = Archive.new_id()
        interrupt_id = str(uuid4())
        plan_request = DevUiPlanRequest(
            deliberation_id,
            interrupt_id,
            plan.to_dict(),
            [{"id": item.id, "name": item.name, "role": item.role} for item in healthy],
        )
        self.pending_plans[deliberation_id] = _PendingPlan(request, plan_request, allowed_ids)
        await ctx.request_info(plan_request, DevUiPlanResponse, request_id=interrupt_id)

    @response_handler(
        request=DevUiPlanRequest,
        response=DevUiPlanResponse,
        workflow_output=str,
    )
    async def confirm_plan(self, original_request, response, ctx) -> None:
        pending = self.pending_plans.get(original_request.deliberation_id)
        error = self._validate_plan_response(pending, original_request, response, ctx.request_id)
        if error:
            await ctx.add_event(WorkflowEvent.warning(error))
            if pending is None:
                await ctx.yield_output(f"审议 {original_request.deliberation_id} 的方案确认已过期。")
                return
            replacement = replace(pending.plan_request, interrupt_id=str(uuid4()))
            pending.plan_request = replacement
            await ctx.request_info(replacement, DevUiPlanResponse, request_id=replacement.interrupt_id)
            return
        assert pending is not None
        if response.action == "cancel":
            self.pending_plans.pop(original_request.deliberation_id, None)
            await ctx.yield_output(f"审议 {original_request.deliberation_id} 已在方案确认时取消。")
            return
        payload = {
            "participants": response.participants or pending.plan_request.plan["participants"],
            "report_agent_id": response.report_agent_id or pending.plan_request.plan["report_agent_id"],
        }
        try:
            plan = parse_plan_payload(
                payload,
                allowed_ids=pending.allowed_ids,
                organizer_agent_id=pending.request.organizer or None,
                source="organizer" if pending.request.organizer else "manual",
            )
        except PlanError as exc:
            await ctx.add_event(WorkflowEvent.warning(str(exc)))
            replacement = replace(pending.plan_request, interrupt_id=str(uuid4()))
            pending.plan_request = replacement
            await ctx.request_info(replacement, DevUiPlanResponse, request_id=replacement.interrupt_id)
            return
        self.pending_plans.pop(original_request.deliberation_id, None)
        await self._start_confirmed_plan(pending.request, plan, original_request.deliberation_id, ctx)

    @staticmethod
    def _validate_plan_response(pending, original, response, workflow_request_id):
        if pending is None:
            return "方案确认已过期"
        current = pending.plan_request
        if original.interrupt_id != current.interrupt_id or workflow_request_id != current.interrupt_id:
            return "方案确认中断 ID 不匹配"
        if response.deliberation_id != original.deliberation_id:
            return "方案确认响应的审议 ID 不匹配"
        if response.interrupt_id != current.interrupt_id:
            return "方案确认响应的中断 ID 不匹配"
        if response.action not in {"confirm", "cancel"}:
            return f"方案确认不支持动作：{response.action}"
        return None

    async def _start_confirmed_plan(self, request, plan: DeliberationPlan, deliberation_id, ctx):
        session = _LiveSession(
            self.engine,
            DeliberationRequest(
                question=request.question,
                agent_ids=plan.agent_ids,
                report_agent_id=plan.report_agent_id,
                workspace=Path(request.workspace) if request.workspace else None,
                direct_workspace=request.direct_workspace,
                interactive=request.interactive,
                convergence=request.convergence,
                roles=plan.roles,
                organizer_agent_id=plan.organizer_agent_id,
            ),
            deliberation_id,
            interactive=request.interactive,
        )
        self.sessions[deliberation_id] = session
        session.start()
        try:
            await self._emit_next_boundary(session, ctx)
        except asyncio.CancelledError:
            self.sessions.pop(deliberation_id, None)
            await session.close()
            raise

    @response_handler(
        request=DevUiCheckpointRequest,
        response=DevUiCheckpointResponse,
        workflow_output=str,
    )
    async def resume_deliberation(
        self,
        original_request,
        response,
        ctx,
    ) -> None:
        session = self.sessions.get(original_request.deliberation_id)
        if session is None:
            await ctx.add_event(WorkflowEvent.warning("恢复请求对应的进程内审议已过期"))
            await ctx.yield_output(f"审议 {original_request.deliberation_id} 已过期，无法恢复。")
            return
        error = session.validate_response(original_request, response, ctx.request_id)
        if error:
            await ctx.add_event(WorkflowEvent.warning(error))
            replacement = session.rotate_interrupt()
            await ctx.request_info(
                replacement,
                DevUiCheckpointResponse,
                request_id=replacement.interrupt_id,
            )
            return
        session.resume(response)
        try:
            await self._emit_next_boundary(session, ctx)
        except asyncio.CancelledError:
            self.sessions.pop(session.deliberation_id, None)
            await session.close()
            raise

    async def _emit_next_boundary(
        self,
        session: _LiveSession,
        ctx: WorkflowContext[None, str],
    ) -> None:
        boundary = await session.boundaries.get()
        if isinstance(boundary, DevUiCheckpointRequest):
            await ctx.request_info(
                boundary,
                DevUiCheckpointResponse,
                request_id=boundary.interrupt_id,
            )
            return
        self.sessions.pop(session.deliberation_id, None)
        if isinstance(boundary, RunResult):
            await ctx.yield_output(boundary.report)
            return
        if isinstance(boundary, _CancelledBoundary):
            await ctx.yield_output(f"审议 {session.deliberation_id} 已取消：{boundary.reason}")
            return
        raise boundary.error


def build_workflow(engine: DeliberationEngine | None = None):
    if engine is None:
        home = app_home()
        engine = DeliberationEngine(load_agents(), home)
    executor = DeliberationExecutor(engine)
    return WorkflowBuilder(start_executor=executor, output_from=[executor], name="本地多 Agent 结构化审议").build()


def serve(port: int = 8080, *, auto_open: bool = True) -> None:
    from agent_framework_devui import serve as devui_serve

    auth_token = os.getenv("DEVUI_AUTH_TOKEN")
    if not auth_token:
        auth_token = secrets.token_urlsafe(32)
        print("DevUI Bearer Token（仅本机使用，请勿分享）：", file=sys.stderr, flush=True)
        print(auth_token, file=sys.stderr, flush=True)

    devui_serve(
        entities=[build_workflow()],
        host="127.0.0.1",
        port=port,
        auto_open=auto_open,
        auth_enabled=True,
        auth_token=auth_token,
        instrumentation_enabled=True,
    )
