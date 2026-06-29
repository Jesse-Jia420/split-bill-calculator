"""Unit tests for the verification-code generator."""
from __future__ import annotations

import pytest

from app.services.verification_code import generate_code


class TestGenerateCode:
    def test_default_length_is_six(self) -> None:
        code = generate_code()
        assert len(code) == 6

    def test_only_contains_digits(self) -> None:
        code = generate_code()
        assert code.isdigit()

    @pytest.mark.parametrize("length", [4, 5, 6, 7, 8, 9, 10])
    def test_custom_length_is_respected(self, length: int) -> None:
        code = generate_code(length=length)
        assert len(code) == length
        assert code.isdigit()

    def test_no_collisions_in_100_codes(self) -> None:
        """Six-digit codes have 10^6 possibilities; 100 samples have
        ~0.5% chance of any collision (birthday paradox:
        p ≈ 1 - exp(-n²/2N) ≈ 0.005). In practice collisions only
        appear around 1000+ samples, so this is a useful smoke test
        that catches catastrophic bias / a broken RNG without
        being flaky. Not a statistical guarantee of uniqueness.
        """
        codes = {generate_code() for _ in range(100)}
        assert len(codes) == 100

    @pytest.mark.parametrize("bad_length", [0, 1, 2, 3, 11, 12, 100])
    def test_invalid_length_raises(self, bad_length: int) -> None:
        with pytest.raises(ValueError, match="between 4 and 10"):
            generate_code(bad_length)
