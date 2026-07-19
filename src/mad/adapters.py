from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .models import AgentProfile


PREFLIGHT_TTL_SECONDS = 600
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_BEARER_TOKEN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_KNOWN_TOKEN = re.compile(r"\b(?:sk|xai|ghp|github_pat|glpat)-?[A-Za-z0-9_-]{12,}\b")
_ANSI_ESCAPE = re.compile(r"\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])")
_REASONIX_THINKING = re.compile(r"(?m)^\s*▎\s*thinking\s*$\n?")
_REASONIX_METRICS = re.compile(r"(?m)^\s*·\s+\d+\s+tok\s+·.*$")


@dataclass(slots=True)
class AdapterResult:
    text: str
    duration_seconds: float
    raw_output: str


@dataclass(slots=True, frozen=True)
class PreflightResult:
    executable_available: bool
    model_ready: bool | None
    project_read_only: bool
    checked_at: float
    error: str | None = None
    cached: bool = False

    @property
    def ready(self) -> bool:
        return self.executable_available and self.model_ready is True and self.error is None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PreflightCache:
    def __init__(
        self,
        ttl_seconds: float = PREFLIGHT_TTL_SECONDS,
        *,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self._entries: dict[tuple[Any, ...], tuple[float, PreflightResult]] = {}
        self._locks: dict[tuple[Any, ...], asyncio.Lock] = {}

    async def get_or_probe(
        self,
        key: tuple[Any, ...],
        probe: Callable[[], Awaitable[PreflightResult]],
    ) -> PreflightResult:
        cached = self._fresh(key)
        if cached:
            return self._as_cached(cached)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._fresh(key)
            if cached:
                return self._as_cached(cached)
            result = await probe()
            self._entries[key] = (self.clock() + self.ttl_seconds, result)
            return result

    def clear(self) -> None:
        self._entries.clear()
        self._locks.clear()

    def _fresh(self, key: tuple[Any, ...]) -> PreflightResult | None:
        entry = self._entries.get(key)
        if not entry:
            return None
        expires_at, result = entry
        if expires_at <= self.clock():
            self._entries.pop(key, None)
            return None
        return result

    @staticmethod
    def _as_cached(result: PreflightResult) -> PreflightResult:
        payload = result.to_dict()
        payload["cached"] = True
        return PreflightResult(**payload)


DEFAULT_PREFLIGHT_CACHE = PreflightCache()


class AdapterError(RuntimeError):
    pass


class CliAdapter:
    def __init__(self, profile: AgentProfile):
        self.profile = profile

    @property
    def executable(self) -> str:
        candidate = self.profile.executable or self.profile.adapter
        if "/" in candidate:
            path = Path(candidate).expanduser()
            resolved = str(path) if path.is_file() and os.access(path, os.X_OK) else None
        else:
            resolved = shutil.which(candidate)
        if not resolved:
            raise AdapterError(f"找不到可执行文件：{candidate}")
        return resolved

    @property
    def supports_project_read_only(self) -> bool:
        return self.profile.adapter.lower() in {"codex", "claude", "claudecode", "grok"}

    def command(self, cwd: Path, prompt: str) -> tuple[list[str], bytes | None]:
        model = ["--model", self.profile.model] if self.profile.model else []
        extra = self.profile.extra_args
        match self.profile.adapter.lower():
            case "codex":
                return (
                    [
                        self.executable,
                        "--ask-for-approval",
                        "never",
                        "exec",
                        "--sandbox",
                        "read-only",
                        "--ephemeral",
                        "--skip-git-repo-check",
                        "--json",
                        "-C",
                        str(cwd),
                        *model,
                        *extra,
                        "-",
                    ],
                    prompt.encode(),
                )
            case "claude" | "claudecode":
                return (
                    [
                        self.executable,
                        "-p",
                        "--output-format",
                        "json",
                        "--permission-mode",
                        "plan",
                        "--tools",
                        "Read,Glob,Grep,WebSearch,WebFetch",
                        "--no-session-persistence",
                        *model,
                        *extra,
                    ],
                    prompt.encode(),
                )
            case "reasonix":
                reasonix_model = ["-model", self.profile.model] if self.profile.model else []
                return (
                    [
                        self.executable,
                        "run",
                        "-dir",
                        str(cwd),
                        *reasonix_model,
                        "-max-steps",
                        "3",
                        *extra,
                    ],
                    prompt.encode(),
                )
            case "grok":
                return (
                    [
                        self.executable,
                        "--output-format",
                        "json",
                        "--permission-mode",
                        "plan",
                        "--no-subagents",
                        "--no-memory",
                        "--cwd",
                        str(cwd),
                        *model,
                        *extra,
                        "--single",
                        prompt,
                    ],
                    None,
                )
            case "pi" | "codebuddy":
                return [self.executable, *model, *extra, prompt], None
            case _:
                raise AdapterError(f"不支持的 CLI 适配器：{self.profile.adapter}")

    async def preflight(
        self,
        cwd: Path,
        *,
        project_mode: bool,
        cache: PreflightCache = DEFAULT_PREFLIGHT_CACHE,
    ) -> PreflightResult:
        key = (
            self.profile.adapter.lower(),
            self.profile.executable,
            self.profile.model,
            tuple(self.profile.extra_args),
            self.profile.timeout_seconds,
            project_mode,
        )

        async def probe() -> PreflightResult:
            checked_at = time.time()
            try:
                self.executable
            except AdapterError as exc:
                return PreflightResult(False, None, self.supports_project_read_only, checked_at, str(exc))
            if project_mode and not self.supports_project_read_only:
                return PreflightResult(
                    True,
                    None,
                    False,
                    checked_at,
                    f"{self.profile.adapter} 未证明支持最低只读约束，禁止项目模式",
                )
            try:
                await self.invoke("只回复 READY，不要执行任何工具。", cwd)
            except AdapterError as exc:
                return PreflightResult(
                    True,
                    False,
                    self.supports_project_read_only,
                    checked_at,
                    str(exc),
                )
            return PreflightResult(True, True, self.supports_project_read_only, checked_at)

        return await cache.get_or_probe(key, probe)

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
            await self._terminate_process_group(process)
            raise AdapterError(f"调用超过 {self.profile.timeout_seconds} 秒") from None
        except asyncio.CancelledError:
            cleanup = asyncio.create_task(self._terminate_process_group(process))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
            raise
        raw = stdout.decode("utf-8", errors="replace")
        error_text = stderr.decode("utf-8", errors="replace")
        if process.returncode != 0:
            detail = error_text.strip() or raw.strip() or f"退出码 {process.returncode}"
            raise AdapterError(self._redact(detail))
        text = self._public_text(raw)
        if not text.strip():
            raise AdapterError("CLI 未返回公开文本")
        return AdapterResult(text=text.strip(), duration_seconds=time.monotonic() - started, raw_output=raw)

    @staticmethod
    async def _terminate_process_group(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
            return
        except TimeoutError:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        await process.wait()

    @staticmethod
    def _public_text(raw: str) -> str:
        documents: list[dict[str, Any]] = []
        stripped = raw.strip()
        if not stripped:
            return ""
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            for line in stripped.splitlines():
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    documents.append(value)
        else:
            if isinstance(value, dict):
                documents.append(value)
        if not documents:
            return CliAdapter._clean_public_text(raw)

        final: list[str] = []
        messages: list[str] = []
        for item in documents:
            result = item.get("result")
            if isinstance(result, str) and result.strip():
                final.append(result)
            nested_item = item.get("item")
            if isinstance(nested_item, dict) and nested_item.get("type") in {"agent_message", "message"}:
                CliAdapter._append_content(messages, nested_item.get("text") or nested_item.get("content"))
            message = item.get("message")
            if isinstance(message, dict):
                CliAdapter._append_content(messages, message.get("content"))
            if item.get("type") in {"assistant", "agent_message", "message"}:
                CliAdapter._append_content(messages, item.get("text") or item.get("content"))
            elif isinstance(item.get("text"), str):
                messages.append(item["text"])
        selected = final or messages
        value = "\n".join(dict.fromkeys(value.strip() for value in selected if value.strip())) or raw
        return CliAdapter._clean_public_text(value)

    @staticmethod
    def _append_content(values: list[str], content: Any) -> None:
        if isinstance(content, str):
            values.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, str):
                    values.append(block)
                elif isinstance(block, dict) and isinstance(block.get("text"), str):
                    values.append(block["text"])

    @staticmethod
    def _redact(value: str) -> str:
        redacted = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value)
        redacted = _BEARER_TOKEN.sub("Bearer [REDACTED]", redacted)
        redacted = _KNOWN_TOKEN.sub("[REDACTED]", redacted)
        for name, secret in os.environ.items():
            if len(secret) >= 8 and any(marker in name.upper() for marker in ("TOKEN", "KEY", "SECRET", "PASSWORD")):
                redacted = redacted.replace(secret, "[REDACTED]")
        return redacted

    @staticmethod
    def _clean_public_text(value: str) -> str:
        value = _ANSI_ESCAPE.sub("", value)
        value = _REASONIX_THINKING.sub("", value)
        value = _REASONIX_METRICS.sub("", value)
        return value.strip()
