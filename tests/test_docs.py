from __future__ import annotations

import re
from pathlib import Path

from mad.cli import parser


ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")


def test_readme_documents_every_public_cli_command_and_option() -> None:
    commands = {action.dest: action for action in parser()._actions if action.dest == "command"}
    choices = commands["command"].choices

    for command, command_parser in choices.items():
        assert f"mad {command}" in README
        for action in command_parser._actions:
            if action.dest == "help":
                continue
            if action.option_strings:
                for option in action.option_strings:
                    assert option in README
            else:
                assert action.dest.upper() in README


def test_cli_help_describes_public_parameters_in_chinese() -> None:
    command_action = next(action for action in parser()._actions if action.dest == "command")
    for command_parser in command_action.choices.values():
        for action in command_parser._actions:
            if action.dest == "help":
                continue
            assert action.help
            assert re.search(r"[\u4e00-\u9fff]", action.help)


def test_readme_keeps_devui_local_and_examples_portable() -> None:
    assert "127.0.0.1" in README
    assert "Bearer Token" in README
    assert "不支持远程或公网暴露" in README
    assert "/Users/" not in README
    assert "/opt/homebrew" not in README
    assert not re.search(r"(?i)(api[_-]?key|token|password)\s*=\s*[\"'][^<{]", README)
    assert not re.search(r"\bsk-[A-Za-z0-9_-]{12,}\b", README)


def test_design_docs_use_current_automation_flag_and_recovery_policy() -> None:
    docs = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "docs").rglob("*.md"))
    assert "--non-interactive" not in docs
    assert "--confirm-plan" in docs
    assert "取消或异常退出后的快照保留" in docs
