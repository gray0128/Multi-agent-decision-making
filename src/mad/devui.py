from __future__ import annotations

import asyncio
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from uuid import uuid4

from agent_framework import Executor, WorkflowBuilder, WorkflowContext, WorkflowEvent, handler, response_handler

from .archive import Archive
from .config import app_home, load_agents
from .engine import DeliberationCancelled, DeliberationEngine
from .models import CheckpointDecision, Contribution, DeliberationRequest, RunResult, Stage


@dataclass
class DevUiRequest:
    question: str
    agents: list[str] = field(default_factory=list)
    report_agent: str = ""
    workspace: str = ""
    direct_workspace: bool = False
    convergence: str = "auto"
    interactive: bool = True


@dataclass
class DevUiCheckpointRequest:
    deliberation_id: str
    interrupt_id: str
    stage: str
    actions: list[str]
    participants: list[dict[str, Any]]
    threshold: int | None = None
    disputes: list[dict[str, Any]] = field(default_factory=list)
    recommended_action: str = "continue"


@dataclass
class DevUiCheckpointResponse:
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


class _LiveSession:
    def __init__(
        self,
        engine: DeliberationEngine,
        request: DeliberationRequest,
        deliberation_id: str,
        *,
        interactive: bool,
    ):
        self.engine = engine
        self.request = request
        self.deliberation_id = deliberation_id
        self.interactive = interactive
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
            result = await self.engine.run(
                self.request,
                checkpoint=self._checkpoint if self.interactive else None,
                deliberation_id=self.deliberation_id,
            )
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

    @handler
    async def deliberate(self, request: DevUiRequest, ctx: WorkflowContext[None, str]) -> None:
        profiles = list(self.engine.profiles.values())
        enabled = [item.id for item in profiles if item.enabled]
        agents = request.agents or enabled
        if not agents:
            raise ValueError("没有可用的 Agent 配置")
        report = request.report_agent or next((item.id for item in profiles if item.default_report), agents[0])
        deliberation_id = Archive.new_id()
        session = _LiveSession(
            self.engine,
            DeliberationRequest(
                question=request.question,
                agent_ids=agents,
                report_agent_id=report,
                workspace=Path(request.workspace) if request.workspace else None,
                direct_workspace=request.direct_workspace,
                interactive=request.interactive,
                convergence=request.convergence,
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

    devui_serve(
        entities=[build_workflow()],
        host="127.0.0.1",
        port=port,
        auto_open=auto_open,
        auth_enabled=True,
        instrumentation_enabled=True,
    )
