from mad.context import estimate_tokens


def test_token_estimate_handles_chinese_and_latin_conservatively():
    assert estimate_tokens("中文测试") == 4
    assert estimate_tokens("abcdefgh") == 2
    assert estimate_tokens("中文abcdefgh") == 4
