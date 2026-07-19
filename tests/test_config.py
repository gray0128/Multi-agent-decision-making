from pathlib import Path

from mad.config import initialize, load_agents


def test_initialize_creates_registry(tmp_path: Path):
    target = initialize(tmp_path)
    assert target.exists()
    profiles = load_agents(target)
    assert {item.adapter for item in profiles} == {"codex", "claude", "reasonix", "grok", "pi", "codebuddy"}


def test_duplicate_ids_are_rejected(tmp_path: Path):
    path = tmp_path / "agents.toml"
    path.write_text('[[agents]]\nid="same"\nname="A"\nadapter="pi"\n[[agents]]\nid="same"\nname="B"\nadapter="pi"\n')
    try:
        load_agents(path)
    except ValueError as exc:
        assert "重复" in str(exc)
    else:
        raise AssertionError("应拒绝重复 ID")
