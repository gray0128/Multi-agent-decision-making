from __future__ import annotations

import asyncio
import json
import signal
import sys
from pathlib import Path

import pytest

from mad.adapters import AdapterError, CliAdapter, PreflightCache
from mad.models import AgentProfile


def profile(adapter: str, **overrides) -> AgentProfile:
    values = {
        "id": adapter,
        "name": adapter.title(),
        "adapter": adapter,
        "executable": sys.executable,
        "model": "test-model",
    }
    values.update(overrides)
    return AgentProfile(**values)


@pytest.mark.parametrize(
    ("adapter", "expected", "stdin_expected"),
    [
        (
            "codex",
            ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "-C"],
            True,
        ),
        ("claude", ["-p", "--output-format", "json", "--permission-mode", "plan"], True),
        ("reasonix", ["run", "-dir", "-model", "test-model", "-max-steps", "3"], True),
        ("grok", ["--output-format", "json", "--permission-mode", "plan", "--single", "PROMPT"], False),
        (
            "pi",
            [
                "--mode",
                "json",
                "--no-session",
                "--no-approve",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--tools",
                "read,grep,find,ls",
                "--model",
                "test-model",
                "PROMPT",
            ],
            False,
        ),
        (
            "codebuddy",
            [
                "-p",
                "--output-format",
                "json",
                "--permission-mode",
                "plan",
                "--tools",
                "Read,Glob,Grep",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--setting-sources",
                "user",
                "--model",
                "test-model",
                "PROMPT",
            ],
            False,
        ),
    ],
)
def test_real_cli_command_contracts(tmp_path: Path, adapter: str, expected: list[str], stdin_expected: bool):
    command, stdin = CliAdapter(profile(adapter)).command(tmp_path, "PROMPT")
    cursor = 0
    for value in expected:
        cursor = command.index(value, cursor) + 1
    assert (stdin == b"PROMPT") is stdin_expected


def test_output_parser_handles_codex_jsonl():
    raw = "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": "x"}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "READY"}}),
        ]
    )
    assert CliAdapter._public_text(raw) == "READY"


def test_output_parser_prefers_final_result_and_handles_content_blocks():
    assert CliAdapter._public_text(json.dumps({"type": "result", "result": "FINAL"})) == "FINAL"
    raw = json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "BLOCK"}]}})
    assert CliAdapter._public_text(raw) == "BLOCK"


def test_output_parser_handles_grok_json_object():
    raw = json.dumps({"text": "READY", "stopReason": "EndTurn", "thought": "private"})
    assert CliAdapter._public_text(raw) == "READY"


def test_output_parser_uses_only_final_pi_assistant_message():
    raw = "\n".join(
        [
            json.dumps({"type": "session", "version": 3, "id": "x"}),
            json.dumps(
                {
                    "type": "message_update",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "PAR"}]},
                }
            ),
            json.dumps(
                {
                    "type": "message_end",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "FINAL"}]},
                }
            ),
            json.dumps(
                {
                    "type": "turn_end",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "FINAL"}]},
                    "toolResults": [],
                }
            ),
        ]
    )
    assert CliAdapter._public_text(raw) == "FINAL"


def test_two_pi_models_share_adapter_but_keep_distinct_commands(tmp_path: Path):
    deepseek = profile("pi", id="pi-deepseek", name="Pi DeepSeek", model="deepseek/deepseek-v4-pro")
    minimax = profile("pi", id="pi-minimax", name="Pi MiniMax", model="minimax/minimax-m3")
    deepseek_command, _ = CliAdapter(deepseek).command(tmp_path, "PROMPT")
    minimax_command, _ = CliAdapter(minimax).command(tmp_path, "PROMPT")
    assert deepseek_command[deepseek_command.index("--model") + 1] == "deepseek/deepseek-v4-pro"
    assert minimax_command[minimax_command.index("--model") + 1] == "minimax/minimax-m3"
    assert deepseek.id != minimax.id and deepseek.name != minimax.name


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("adapter", "stdout"),
    [
        (
            "pi",
            b'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"READY"}]}}\n',
        ),
        ("codebuddy", b'{"type":"result","result":"READY"}'),
    ],
)
async def test_pi_and_codebuddy_complete_normalized_plain_text_invocation(
    monkeypatch, tmp_path: Path, adapter: str, stdout: bytes
):
    process = FakeProcess(stdout=stdout)
    launched = []

    async def create(*command, **_kwargs):
        launched.append(command)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    result = await CliAdapter(profile(adapter)).invoke("PROMPT", tmp_path)
    assert result.text == "READY"
    assert launched and launched[0][-1] == "PROMPT"


def test_plain_output_strips_reasonix_terminal_metadata():
    raw = "\x1b[2m  ▎ thinking\x1b[0m\nREADY\n  · 123 tok · in 100 · out 23 · ¥0.01"
    assert CliAdapter._public_text(raw) == "READY"


def test_plain_text_output_is_preserved():
    assert CliAdapter._public_text("plain response") == "plain response"


class FakeProcess:
    def __init__(self, *, stdout: bytes = b"READY", stderr: bytes = b"", returncode: int | None = 0, block=False):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.block = block
        self.pid = 4242
        self._event = asyncio.Event()

    async def communicate(self, _stdin):
        if self.block:
            await self._event.wait()
        return self.stdout, self.stderr

    async def wait(self):
        self.returncode = -signal.SIGTERM
        return self.returncode


@pytest.mark.asyncio
async def test_nonzero_error_is_redacted(monkeypatch, tmp_path: Path):
    process = FakeProcess(
        stderr=b"api_key=sk-abcdefghijklmnopqrstuvwxyz; raw sk-proj-abcdefghijklmnopqrstuvwxyz",
        returncode=1,
    )

    async def create(*_args, **_kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    with pytest.raises(AdapterError) as caught:
        await CliAdapter(profile("codex")).invoke("PROMPT", tmp_path)
    assert "abcdefghijklmnopqrstuvwxyz" not in str(caught.value)
    assert "[REDACTED]" in str(caught.value)


@pytest.mark.asyncio
async def test_timeout_terminates_process_group(monkeypatch, tmp_path: Path):
    process = FakeProcess(returncode=None, block=True)
    signals: list[int] = []

    async def create(*_args, **_kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    monkeypatch.setattr("mad.adapters.os.killpg", lambda _pid, sig: signals.append(sig))
    with pytest.raises(AdapterError, match="调用超过"):
        await CliAdapter(profile("codex", timeout_seconds=0.01)).invoke("PROMPT", tmp_path)
    assert signals == [signal.SIGTERM]
    assert process.returncode is not None


@pytest.mark.asyncio
async def test_cancellation_terminates_process_group(monkeypatch, tmp_path: Path):
    process = FakeProcess(returncode=None, block=True)
    signals: list[int] = []

    async def create(*_args, **_kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    monkeypatch.setattr("mad.adapters.os.killpg", lambda _pid, sig: signals.append(sig))
    task = asyncio.create_task(CliAdapter(profile("codex")).invoke("PROMPT", tmp_path))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert signals == [signal.SIGTERM]
    assert process.returncode is not None


@pytest.mark.asyncio
async def test_preflight_cache_reuses_success_for_ten_minutes(monkeypatch, tmp_path: Path):
    now = [0.0]
    cache = PreflightCache(clock=lambda: now[0])
    adapter = CliAdapter(profile("codex"))
    calls = 0

    async def invoke(_prompt, _cwd):
        nonlocal calls
        calls += 1
        return object()

    monkeypatch.setattr(adapter, "invoke", invoke)
    first = await adapter.preflight(tmp_path, project_mode=False, cache=cache)
    now[0] = 599
    second = await adapter.preflight(tmp_path / "another", project_mode=False, cache=cache)
    now[0] = 601
    third = await adapter.preflight(tmp_path, project_mode=False, cache=cache)
    assert first.ready and not first.cached
    assert second.ready and second.cached
    assert third.ready and not third.cached
    assert calls == 2


@pytest.mark.asyncio
async def test_preflight_distinguishes_missing_executable(tmp_path: Path):
    adapter = CliAdapter(profile("codex", executable=str(tmp_path / "missing")))
    result = await adapter.preflight(tmp_path, project_mode=False, cache=PreflightCache())
    assert result.executable_available is False
    assert result.model_ready is None
    assert "找不到可执行文件" in result.error


@pytest.mark.asyncio
async def test_unproven_read_only_adapter_is_rejected_before_model_call(monkeypatch, tmp_path: Path):
    adapter = CliAdapter(profile("reasonix"))

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("不应发起模型调用")

    monkeypatch.setattr(adapter, "invoke", unexpected)
    result = await adapter.preflight(tmp_path, project_mode=True, cache=PreflightCache())
    assert result.executable_available is True
    assert result.model_ready is None
    assert result.project_read_only is False
    assert "禁止项目模式" in result.error


@pytest.mark.parametrize("adapter", ["pi", "codebuddy"])
def test_pi_and_codebuddy_declare_minimum_project_read_only_capability(adapter):
    assert CliAdapter(profile(adapter)).supports_project_read_only is True
