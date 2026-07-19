from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


SENSITIVE_NAMES = {".git", ".env", ".ssh", ".aws", ".azure", "node_modules", ".venv", "dist", "build"}
SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}


def _safe(relative: Path) -> bool:
    return (
        not any(part in SENSITIVE_NAMES or part.startswith(".env") for part in relative.parts)
        and relative.suffix.lower() not in SENSITIVE_SUFFIXES
    )


def create_snapshot(workspace: Path, target: Path) -> Path:
    workspace = workspace.expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError(f"工作目录不存在：{workspace}")
    target.mkdir(parents=True, exist_ok=False)
    git = subprocess.run(
        ["git", "-C", str(workspace), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
        check=False,
    )
    if git.returncode == 0:
        listed = subprocess.run(
            ["git", "-C", str(workspace), "ls-files", "-z"], capture_output=True, check=True
        ).stdout.split(b"\0")
        paths = [Path(item.decode()) for item in listed if item]
    else:
        paths = []
        for item in workspace.rglob("*"):
            relative = item.relative_to(workspace)
            if item.is_file() and not any(part.startswith(".") for part in relative.parts):
                paths.append(relative)
    for relative in paths:
        if not _safe(relative):
            continue
        source = workspace / relative
        if source.is_file() and not source.is_symlink():
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    return target
