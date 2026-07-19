from mad.cli import parser


def test_workspace_is_never_implicit():
    args = parser().parse_args(["deliberate", "一个问题"])
    assert args.workspace is None
    assert args.direct_workspace is False


def test_project_mode_is_explicit():
    args = parser().parse_args(["deliberate", "一个问题", "-w", ".", "--direct-workspace"])
    assert str(args.workspace) == "."
    assert args.direct_workspace is True
