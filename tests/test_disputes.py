from mad.disputes import parse_revision


def test_parse_revision_separates_public_text_and_signal():
    parsed = parse_revision(
        '修订后的结论\n```json\n{"has_critical_dispute":true,"disputes":[{"title":"争议","impact":"改变结论"}]}\n```'
    )
    assert parsed.public_text == "修订后的结论"
    assert parsed.signal["has_critical_dispute"] is True
    assert parsed.warning is None


def test_invalid_signal_is_not_inferred():
    parsed = parse_revision("我似乎仍有争议，但没有 JSON")
    assert parsed.signal is None
    assert parsed.warning
