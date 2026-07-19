from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

from .config import agents_path, app_home, initialize, load_agents
from .engine import DeliberationCancelled, DeliberationEngine, DeliberationError
from .models import CheckpointDecision, DeliberationRequest, Stage
from .planning import DeliberationPlan, OrganizerService, PlanError, manual_plan, parse_plan_payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="mad", description="本地多 Agent 结构化审议工具")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="初始化用户配置")
    init.add_argument("--force", action="store_true", help="覆盖现有 agents.toml（请先备份）")

    commands.add_parser("agents", help="列出 Agent 配置")
    deliberate = commands.add_parser("deliberate", help="发起一次审议")
    deliberate.add_argument("question", help="要审议的问题")
    deliberate.add_argument("--workspace", "-w", type=Path, help="材料工作目录；默认制作只读快照")
    deliberate.add_argument("--direct-workspace", action="store_true", help="直接只读访问原工作目录")
    deliberate.add_argument("--agents", help="逗号分隔的 Agent ID")
    deliberate.add_argument("--report-agent", help="负责草拟和定稿的参与者 ID")
    deliberate.add_argument("--organizer", help="按次启用的组局 Agent ID；默认关闭")
    deliberate.add_argument(
        "--role", action="append", default=[], metavar="AGENT_ID=ROLE", help="覆盖参与者的本次临时角色；可重复"
    )
    deliberate.add_argument("--confirm-plan", action="store_true", help="确认最终审议方案并跳过终端询问")
    deliberate.add_argument("--interactive", action="store_true", help="启用四个阶段检查点")
    deliberate.add_argument(
        "--convergence", choices=("auto", "always", "never"), default="auto", help="争议收敛策略"
    )
    deliberate.add_argument("--format", choices=("markdown", "json"), default="markdown", help="标准输出格式")
    deliberate.add_argument("--concurrency", type=int, default=6, help="最大并发调用数（1-6）")

    resume_command = commands.add_parser("resume", help="恢复一次未完成的审议")
    resume_command.add_argument("deliberation_id", help="审议档案目录名中的 ID")
    resume_command.add_argument("--interactive", action="store_true", help="恢复等待中的交互检查点")
    resume_command.add_argument("--format", choices=("markdown", "json"), default="markdown", help="标准输出格式")
    resume_command.add_argument("--concurrency", type=int, default=6, help="最大并发调用数（1-6）")

    serve = commands.add_parser("serve", help="启动 DevUI")
    serve.add_argument("--port", type=int, default=8080, help="本机监听端口（默认 8080）")
    serve.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    clean = commands.add_parser("clean-temp", help="清理孤立临时文件")
    clean.add_argument("--yes", action="store_true", help="跳过确认")
    return root


async def _checkpoint(stage: Stage, _items) -> CheckpointDecision | str | None:
    print(f"\n阶段检查点：{stage.value}", file=sys.stderr)
    if stage == Stage.DISPUTE_DECISION:
        for item in _items:
            signal = item.metadata.get("dispute_signal")
            if not signal:
                print(f"- {item.agent_name}：争议信号无效", file=sys.stderr)
                continue
            titles = "；".join(value["title"] for value in signal.get("disputes", [])) or "无"
            print(f"- {item.agent_name}：{titles}", file=sys.stderr)
        answer = input("回车采用自动判断；输入 /trigger [争议] 强制触发；输入 /skip 跳过；输入 /cancel 取消：").strip()
        if answer == "/cancel":
            return CheckpointDecision(action="cancel")
        return answer or None
    answer = input("直接回车继续；输入指导意见后继续；输入 /cancel 取消：").strip()
    if answer == "/cancel":
        return CheckpointDecision(action="cancel")
    return answer or None


async def deliberate(args: argparse.Namespace) -> int:
    home = app_home()
    initialize(home)
    profiles = [item for item in load_agents() if item.enabled]
    if not profiles:
        print(f"没有可用 Agent 配置，请编辑 {agents_path()}", file=sys.stderr)
        return 3
    if args.direct_workspace and not args.workspace:
        print("--direct-workspace 必须与 --workspace 一起使用", file=sys.stderr)
        return 2
    try:
        role_overrides = _parse_role_overrides(args.role)
        planning_cwd = args.workspace.expanduser().resolve() if args.workspace else home
        if not planning_cwd.is_dir():
            raise PlanError(f"工作目录不存在：{planning_cwd}")
        planner = OrganizerService(profiles)
        healthy = await planner.preflight(planning_cwd, project_mode=args.workspace is not None)
        healthy_ids = {item.id for item in healthy}
        if len(healthy) < 2:
            raise PlanError("预检后可用参与者不足两个")
        if args.organizer:
            suggested = await planner.propose(args.question, args.organizer, healthy, planning_cwd)
            plan = _override_plan(suggested, profiles, healthy_ids, args, role_overrides)
        else:
            ids = args.agents.split(",") if args.agents else [item.id for item in healthy]
            report = args.report_agent or next((item.id for item in healthy if item.default_report), ids[0])
            plan = manual_plan(profiles, ids, report, role_overrides, allowed_ids=healthy_ids)
        plan = _confirm_plan(plan, healthy_ids, confirmed=args.confirm_plan)
    except KeyboardInterrupt:
        return 130
    except (PlanError, EOFError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    engine = DeliberationEngine(profiles, home, concurrency=max(1, min(args.concurrency, 6)))
    try:
        result = await engine.run(
            DeliberationRequest(
                args.question,
                plan.agent_ids,
                plan.report_agent_id,
                args.workspace,
                args.direct_workspace,
                interactive=args.interactive,
                convergence=args.convergence,
                roles=plan.roles,
                organizer_agent_id=plan.organizer_agent_id,
            ),
            checkpoint=_checkpoint if args.interactive else None,
            progress=lambda message: print(message, file=sys.stderr, flush=True),
        )
    except (KeyboardInterrupt, DeliberationCancelled):
        return 130
    except (DeliberationError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 3 if "不足" in str(exc) else 1
    if args.format == "json":
        print(json.dumps(result.to_dict(), ensure_ascii=False))
    else:
        print(result.report)
        print(f"\n审议档案：{result.archive_path}", file=sys.stderr)
    return 0


def _parse_role_overrides(values: list[str]) -> dict[str, str]:
    result = {}
    for value in values:
        agent_id, separator, role = value.partition("=")
        if not separator or not agent_id.strip() or not role.strip():
            raise PlanError(f"临时角色格式应为 AGENT_ID=ROLE：{value}")
        result[agent_id.strip()] = role.strip()
    return result


def _override_plan(suggested, profiles, healthy_ids, args, role_overrides):
    ids = args.agents.split(",") if args.agents else suggested.agent_ids
    suggested_roles = suggested.roles
    roles = {agent_id: suggested_roles.get(agent_id, "") for agent_id in ids}
    roles.update(role_overrides)
    report = args.report_agent or suggested.report_agent_id
    return manual_plan(
        profiles,
        ids,
        report,
        roles,
        allowed_ids=healthy_ids,
        organizer_agent_id=args.organizer,
    )


def _confirm_plan(plan: DeliberationPlan, allowed_ids: set[str], *, confirmed: bool) -> DeliberationPlan:
    print("最终审议方案：", file=sys.stderr)
    print(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2), file=sys.stderr)
    if confirmed:
        return plan
    answer = input("直接回车确认；输入 JSON 修改参与者、角色和报告 Agent；输入 /cancel 取消：").strip()
    if answer == "/cancel":
        raise PlanError("已取消")
    if not answer:
        return plan
    return parse_plan_payload(
        answer,
        allowed_ids=allowed_ids,
        organizer_agent_id=plan.organizer_agent_id,
        source=plan.source,
    )


async def resume(args: argparse.Namespace) -> int:
    home = app_home()
    initialize(home)
    profiles = [item for item in load_agents() if item.enabled]
    engine = DeliberationEngine(profiles, home, concurrency=max(1, min(args.concurrency, 6)))
    try:
        result = await engine.resume(
            args.deliberation_id,
            checkpoint=_checkpoint if args.interactive else None,
            progress=lambda message: print(message, file=sys.stderr, flush=True),
        )
    except (KeyboardInterrupt, DeliberationCancelled):
        return 130
    except (DeliberationError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.format == "json":
        print(json.dumps(result.to_dict(), ensure_ascii=False))
    else:
        print(result.report)
        print(f"\n审议档案：{result.archive_path}", file=sys.stderr)
    return 0


def _temp_candidates(temp: Path) -> list[Path]:
    if not temp.exists():
        return []
    protected = {".mad-active", ".mad-recoverable"}
    return [item for item in temp.iterdir() if not any((item / marker).exists() for marker in protected)]


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    if args.command == "init":
        print(initialize(force=args.force))
        raise SystemExit(0)
    if args.command == "agents":
        initialize()
        for item in load_agents():
            print(f"{item.id}\t{item.name}\t{item.adapter}\t{'启用' if item.enabled else '禁用'}")
        raise SystemExit(0)
    if args.command == "deliberate":
        raise SystemExit(asyncio.run(deliberate(args)))
    if args.command == "resume":
        raise SystemExit(asyncio.run(resume(args)))
    if args.command == "serve":
        initialize()
        from .devui import serve

        serve(args.port, auto_open=not args.no_open)
        raise SystemExit(0)
    if args.command == "clean-temp":
        temp = app_home() / "temp"
        candidates = _temp_candidates(temp)
        if not candidates:
            print("没有可清理的孤立临时文件")
            raise SystemExit(0)
        for item in candidates:
            print(item)
        if not args.yes and input(f"确认清理以上 {len(candidates)} 项？[y/N] ").lower() != "y":
            print("已取消")
            raise SystemExit(0)
        for item in candidates:
            shutil.rmtree(item) if item.is_dir() else item.unlink()
        print(f"已清理 {len(candidates)} 项")
        raise SystemExit(0)


if __name__ == "__main__":
    main()
