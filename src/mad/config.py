from __future__ import annotations

import os
import shutil
import tomllib
from dataclasses import fields
from pathlib import Path

from .models import AgentProfile


APP_DIR_ENV = "MAD_HOME"


def app_home() -> Path:
    override = os.environ.get(APP_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MultiAgentDecision"


def agents_path(home: Path | None = None) -> Path:
    return (home or app_home()) / "config" / "agents.toml"


def load_agents(path: Path | None = None) -> list[AgentProfile]:
    source = path or agents_path()
    if not source.exists():
        return []
    raw = tomllib.loads(source.read_text(encoding="utf-8"))
    allowed = {item.name for item in fields(AgentProfile)}
    profiles = [AgentProfile(**{k: v for k, v in row.items() if k in allowed}) for row in raw.get("agents", [])]
    ids = [profile.id for profile in profiles]
    if len(ids) != len(set(ids)):
        raise ValueError("agents.toml 中存在重复的 Agent ID")
    if sum(profile.default_report for profile in profiles if profile.enabled) > 1:
        raise ValueError("只能配置一个默认报告 Agent")
    return profiles


def default_agents_toml() -> str:
    detected = {name: shutil.which(name) for name in ("codex", "claude", "reasonix", "grok", "pi", "codebuddy")}
    blocks = ["# Agent 注册表。秘密继续由各 CLI 自己管理，请勿写入本文件。\n"]
    for index, (adapter, executable) in enumerate(detected.items()):
        blocks.append(
            "\n".join(
                [
                    "[[agents]]",
                    f'id = "{adapter}"',
                    f'name = "{adapter.title()}"',
                    f'adapter = "{adapter}"',
                    f'executable = "{executable or adapter}"',
                    'role = "独立分析问题，明确事实、推断、风险和建议"',
                    f"enabled = {'true' if executable else 'false'}",
                    f"default_report = {'true' if index == 0 and executable else 'false'}",
                    "timeout_seconds = 300",
                    "context_budget = 64000",
                    "extra_args = []",
                    "",
                ]
            )
        )
    return "\n".join(blocks)


def initialize(home: Path | None = None, *, force: bool = False) -> Path:
    root = home or app_home()
    for child in ("config", "deliberations", "logs", "temp"):
        (root / child).mkdir(parents=True, exist_ok=True)
    target = agents_path(root)
    if target.exists() and not force:
        return target
    target.write_text(default_agents_toml(), encoding="utf-8")
    return target
