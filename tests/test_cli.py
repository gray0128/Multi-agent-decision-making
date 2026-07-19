from mad.cli import _temp_candidates, parser


def test_workspace_is_never_implicit():
    args = parser().parse_args(["deliberate", "一个问题"])
    assert args.workspace is None
    assert args.direct_workspace is False


def test_project_mode_is_explicit():
    args = parser().parse_args(["deliberate", "一个问题", "-w", ".", "--direct-workspace"])
    assert str(args.workspace) == "."
    assert args.direct_workspace is True


def test_resume_command_accepts_interactive_mode():
    args = parser().parse_args(["resume", "run-123", "--interactive", "--format", "json"])
    assert args.deliberation_id == "run-123"
    assert args.interactive is True
    assert args.format == "json"


def test_clean_temp_protects_active_and_recoverable_snapshots(tmp_path):
    active = tmp_path / "active"
    recoverable = tmp_path / "recoverable"
    orphan = tmp_path / "orphan"
    for item in (active, recoverable, orphan):
        item.mkdir()
    (active / ".mad-active").write_text("active")
    (recoverable / ".mad-recoverable").write_text("recoverable")

    assert _temp_candidates(tmp_path) == [orphan]
