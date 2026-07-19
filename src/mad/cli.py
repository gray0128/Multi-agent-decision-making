from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

from .config import agents_path, app_home, initialize, load_agents
from .engine import DeliberationEngine, DeliberationError
from .models import DeliberationRequest, Stage


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="mad", description="本地多 Agent 结构化审议工具")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="初始化用户配置")
    init.add_argument("--force", action="store_true")

    commands.add_parser("agents", help="列出 Agent 配置")
    deliberate = commands.add_parser("deliberate", help="发起一次审议")
    deliberate.add_argument("question")
    deliberate.add_argument("--workspace", "-w", type=Path)
    deliberate.add_argument("--direct-workspace", action="store_true")
    deliberate.add_argument("--agents", help="逗号分隔的 Agent ID")
    deliberate.add_argument("--report-agent")
    deliberate.add_argument("--interactive", action="store_true")
    deliberate.add_argument("--convergence", choices=("auto", "always", "never"), default="auto")
    deliberate.add_argument("--format", choices=("markdown", "json"), default="markdown")
    deliberate.add_argument("--concurrency", type=int, default=6)

    serve = commands.add_parser("serve", help="启动 DevUI")
    serve.add_argument("--port", type=int, default=8080)
    serve.add_argument("--no-open", action="store_true")
    clean = commands.add_parser("clean-temp", help="清理孤立临时文件")
    clean.add_argument("--yes", action="store_true", help="跳过确认")
    return root


async def _checkpoint(stage: Stage, _items) -> str | None:
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
            raise KeyboardInterrupt
        return answer or None
    answer = input("直接回车继续；输入指导意见后继续；输入 /cancel 取消：").strip()
    if answer == "/cancel":
        raise KeyboardInterrupt
    return answer or None


async def deliberate(args: argparse.Namespace) -> int:
    home = app_home()
    initialize(home)
    profiles = [item for item in load_agents() if item.enabled]
    if not profiles:
        print(f"没有可用 Agent 配置，请编辑 {agents_path()}", file=sys.stderr)
        return 3
    ids = args.agents.split(",") if args.agents else [item.id for item in profiles]
    report = args.report_agent or next((item.id for item in profiles if item.default_report), ids[0])
    if args.direct_workspace and not args.workspace:
        print("--direct-workspace 必须与 --workspace 一起使用", file=sys.stderr)
        return 2
    engine = DeliberationEngine(profiles, home, concurrency=max(1, min(args.concurrency, 6)))
    try:
        result = await engine.run(
            DeliberationRequest(
                args.question,
                ids,
                report,
                args.workspace,
                args.direct_workspace,
                interactive=args.interactive,
                convergence=args.convergence,
            ),
            checkpoint=_checkpoint if args.interactive else None,
            progress=lambda message: print(message, file=sys.stderr, flush=True),
        )
    except KeyboardInterrupt:
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
    if args.command == "serve":
        initialize()
        from .devui import serve

        serve(args.port, auto_open=not args.no_open)
        raise SystemExit(0)
    if args.command == "clean-temp":
        temp = app_home() / "temp"
        candidates = [item for item in temp.iterdir() if not (item / ".mad-active").exists()] if temp.exists() else []
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
