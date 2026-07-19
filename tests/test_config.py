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


def test_same_pi_adapter_supports_distinct_provider_model_agents(tmp_path: Path):
    path = tmp_path / "agents.toml"
    path.write_text(
        '''[[agents]]
id="pi-deepseek"
name="Pi · DeepSeek V4 Pro"
adapter="pi"
model="deepseek/deepseek-v4-pro"
executable="/opt/homebrew/bin/pi"

[[agents]]
id="pi-minimax"
name="Pi · MiniMax-M3"
adapter="pi"
model="minimax/minimax-m3"
executable="/opt/homebrew/bin/pi"
'''
    )
    profiles = load_agents(path)
    assert [item.id for item in profiles] == ["pi-deepseek", "pi-minimax"]
    assert [item.name for item in profiles] == ["Pi · DeepSeek V4 Pro", "Pi · MiniMax-M3"]
    assert [item.model for item in profiles] == ["deepseek/deepseek-v4-pro", "minimax/minimax-m3"]
    assert len({item.executable for item in profiles}) == 1
