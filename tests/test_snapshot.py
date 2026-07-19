import subprocess
from pathlib import Path

from mad.snapshot import create_snapshot


def test_git_snapshot_only_copies_tracked_safe_files(tmp_path: Path):
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    (source / "main.py").write_text("print('ok')")
    (source / ".env").write_text("SECRET=bad")
    (source / ".env.local").write_text("SECRET=also-bad")
    (source / "untracked.txt").write_text("ignore")
    subprocess.run(["git", "-C", str(source), "add", "main.py"], check=True)
    subprocess.run(["git", "-C", str(source), "add", "-f", ".env", ".env.local"], check=True)
    target = create_snapshot(source, tmp_path / "snapshot")
    assert (target / "main.py").exists()
    assert not (target / ".env").exists()
    assert not (target / ".env.local").exists()
    assert not (target / "untracked.txt").exists()


def test_git_snapshot_does_not_follow_tracked_symlink_outside_workspace(tmp_path: Path):
    outside = tmp_path / "outside.txt"
    outside.write_text("SECRET")
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    (source / "linked.txt").symlink_to(outside)
    subprocess.run(["git", "-C", str(source), "add", "linked.txt"], check=True)

    target = create_snapshot(source, tmp_path / "snapshot")

    assert not (target / "linked.txt").exists()


def test_non_git_snapshot_excludes_hidden_tree_and_environment_variants(tmp_path: Path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "visible.txt").write_text("PUBLIC")
    (source / ".env.local").write_text("SECRET=bad")
    hidden = source / ".private"
    hidden.mkdir()
    (hidden / "credentials.json").write_text("SECRET")

    target = create_snapshot(source, tmp_path / "snapshot")

    assert (target / "visible.txt").read_text() == "PUBLIC"
    assert not (target / ".env.local").exists()
    assert not (target / ".private" / "credentials.json").exists()
