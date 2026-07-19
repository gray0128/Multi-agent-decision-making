from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler

from .config import app_home, load_agents
from .engine import DeliberationEngine
from .models import DeliberationRequest


@dataclass
class DevUiRequest:
    question: str
    agents: list[str] = field(default_factory=list)
    report_agent: str = ""
    workspace: str = ""
    direct_workspace: bool = False
    convergence: str = "auto"


class DeliberationExecutor(Executor):
    def __init__(self, engine: DeliberationEngine):
        super().__init__("structured-deliberation")
        self.engine = engine

    @handler
    async def deliberate(self, request: DevUiRequest, ctx: WorkflowContext[None, str]) -> None:
        profiles = list(self.engine.profiles.values())
        enabled = [item.id for item in profiles if item.enabled]
        agents = request.agents or enabled
        report = request.report_agent or next((item.id for item in profiles if item.default_report), agents[0])
        result = await self.engine.run(
            DeliberationRequest(
                question=request.question,
                agent_ids=agents,
                report_agent_id=report,
                workspace=Path(request.workspace) if request.workspace else None,
                direct_workspace=request.direct_workspace,
                convergence=request.convergence,
            )
        )
        await ctx.yield_output(result.report)


def build_workflow():
    home = app_home()
    executor = DeliberationExecutor(DeliberationEngine(load_agents(), home))
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
