#!/usr/bin/env python3
"""显式运行真实双 Agent 审议；会调用已认证模型并可能产生费用。"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
from pathlib import Path

from mad.config import app_home, load_agents
from mad.engine import DeliberationEngine
from mad.models import AgentProfile, DeliberationRequest


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--agents", required=True, help="至少两个 agents.toml 中的 Agent ID，逗号分隔")
    value.add_argument("--report-agent", help="默认使用第一个参与者")
    value.add_argument("--workspace", type=Path, help="可选的只读项目目录")
    value.add_argument("--confirm-live", action="store_true", help="确认发起真实模型调用")
    return value


async def run(args: argparse.Namespace) -> int:
    if not args.confirm_live:
        raise SystemExit("拒绝运行：实机冒烟会调用真实模型；请显式传入 --confirm-live")
    agent_ids = [value.strip() for value in args.agents.split(",") if value.strip()]
    if len(agent_ids) < 2:
        raise SystemExit("实机冒烟至少需要两个 Agent ID")
    profiles = load_agents()
    if not profiles:
        profiles = [
            AgentProfile(adapter, adapter.title(), adapter, executable=shutil.which(adapter))
            for adapter in ("codex", "claude", "reasonix", "grok")
            if shutil.which(adapter)
        ]
    known = {profile.id for profile in profiles}
    missing = sorted(set(agent_ids) - known)
    if missing:
        raise SystemExit(f"agents.toml 中不存在：{', '.join(missing)}")
    home = app_home()
    for child in ("config", "deliberations", "logs", "temp"):
        (home / child).mkdir(parents=True, exist_ok=True)
    engine = DeliberationEngine(profiles, home)
    result = await engine.run(
        DeliberationRequest(
            question="用一句话说明 READY，并确认本次没有修改任何文件。",
            agent_ids=agent_ids,
            report_agent_id=args.report_agent or agent_ids[0],
            workspace=args.workspace,
            direct_workspace=bool(args.workspace),
            convergence="never",
        ),
        progress=lambda message: print(message, flush=True),
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parser().parse_args())))
