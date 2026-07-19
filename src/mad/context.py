from __future__ import annotations

import math


def estimate_tokens(text: str) -> int:
    """Conservative dependency-free estimate for mixed Chinese and Latin prompts."""
    wide = sum(1 for character in text if ord(character) > 127 and not character.isspace())
    narrow = sum(1 for character in text if ord(character) <= 127 and not character.isspace())
    return wide + math.ceil(narrow / 4)
