"""Generate 6-digit verification codes (cryptographically secure)."""
from __future__ import annotations

import secrets


def generate_code(length: int = 6) -> str:
    """Return a numeric verification code of the requested length.

    Uses ``secrets.randbelow`` to avoid the bias of ``random`` and to
    guarantee cryptographic strength. The default length matches the
    PRD's "6 位验证码" requirement.

    Raises ValueError if ``length`` is outside the safe range [4, 10].
    """
    if length < 4 or length > 10:
        raise ValueError(f"code length must be between 4 and 10, got {length}")
    return "".join(str(secrets.randbelow(10)) for _ in range(length))
