from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import time
from dataclasses import dataclass
from pathlib import Path

from .models import AgentProfile


@dataclass(slots=True)
class AdapterResult:
    text: str
    duration_seconds: float
    raw_output: str


class AdapterError(RuntimeError):
    pass


class CliAdapter:
    def __init__(self, profile: AgentProfile):
        self.profile = profile

    @property
    def executable(self) -> str:
        candidate = self.profile.executable or self.profile.adapter
        resolved = shutil.which(candidate) if "/" not in candidate else candidate
        if not resolved:
            raise AdapterError(f"找不到可执行文件：{candidate}")
        return resolved

    def command(self, cwd: Path, prompt: str) -> tuple[list[str], bytes | None]:
        model = ["--model", self.profile.model] if self.profile.model else []
        extra = self.profile.extra_args
        match self.profile.adapter:
            case "codex":
                return [self.executable, "--ask-for-approval", "never", "exec", "--sandbox", "read-only", "--json", "-C", str(cwd), *model, *extra, "-"], prompt.encode()
            case "claude" | "claudecode":
                return [self.executable, "-p", "--output-format", "stream-json", "--permission-mode", "plan", "--tools", "Read,Glob,Grep,WebSearch,WebFetch", *model, *extra], prompt.encode()
            case "reasonix":
                return [self.executable, "run", *model, "--max-steps", "3", *extra], prompt.encode()
            case "grok":
                return [self.executable, "--output-format", "streaming-json", "--permission-mode", "plan", "--no-subagents", "--cwd", str(cwd), *model, *extra, "--single", prompt], None
            case "pi" | "codebuddy":
                return [self.executable, *model, *extra, prompt], None
            case _:
                raise AdapterError(f"不支持的 CLI 适配器：{self.profile.adapter}")

    async def invoke(self, prompt: str, cwd: Path) -> AdapterResult:
        if os.environ.get("MAD_PARTICIPANT") == "1":
            raise AdapterError("禁止从参与者进程递归调用 mad")
        started = time.monotonic()
        env = os.environ.copy()
        env["MAD_PARTICIPANT"] = "1"
        command, stdin_data = self.command(cwd, prompt)
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(stdin_data), timeout=self.profile.timeout_seconds
            )
        except TimeoutError:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
            raise AdapterError(f"调用超过 {self.profile.timeout_seconds} 秒")
        raw = stdout.decode("utf-8", errors="replace")
        error_text = stderr.decode("utf-8", errors="replace")
        if process.returncode != 0:
            raise AdapterError(error_text.strip() or raw.strip() or f"退出码 {process.returncode}")
        text = self._public_text(raw)
        if not text.strip():
            raise AdapterError("CLI 未返回公开文本")
        return AdapterResult(text=text.strip(), duration_seconds=time.monotonic() - started, raw_output=raw)

    @staticmethod
    def _public_text(raw: str) -> str:
        values: list[str] = []
        parsed_any = False
        for line in raw.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            parsed_any = True
            for key in ("result", "text", "content"):
                value = item.get(key)
                if isinstance(value, str):
                    values.append(value)
            message = item.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    values.append(content)
        return "\n".join(values) if parsed_any and values else raw
