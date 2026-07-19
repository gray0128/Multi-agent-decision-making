import subprocess
from pathlib import Path

from mad.snapshot import create_snapshot


def test_git_snapshot_only_copies_tracked_safe_files(tmp_path: Path):
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    (source / "main.py").write_text("print('ok')")
    (source / ".env").write_text("SECRET=bad")
    (source / "untracked.txt").write_text("ignore")
    subprocess.run(["git", "-C", str(source), "add", "main.py"], check=True)
    subprocess.run(["git", "-C", str(source), "add", "-f", ".env"], check=True)
    target = create_snapshot(source, tmp_path / "snapshot")
    assert (target / "main.py").exists()
    assert not (target / ".env").exists()
    assert not (target / "untracked.txt").exists()
