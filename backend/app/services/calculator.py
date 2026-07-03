r"""AmountCalculator — v0.2.1 T01 (PRD §3.6.1 / SPEC §3.6).

Evaluate a simple arithmetic expression into a Decimal amount using a
safe, non-eval approach.

Constraints (PRD §3.6.1):
- Whitelist: only ``[0-9+\-*/.\s]`` characters
- Linear 4 operators only (no parentheses, no unary sign except a
  leading minus or after another operator)
- 2-decimal financial precision: keep intermediate math at higher
  precision (Decimal ctx precision=28), quantise the final value to
  cents (Decimal('0.01'))
- Raises ``ValueError`` on any violation or evaluation error — callers
  must translate this to a 422.

Examples
--------
>>> AmountCalculator.evaluate("350/5")
Decimal('70.00')
>>> AmountCalculator.evaluate("0.1+0.2")
Decimal('0.30')
>>> AmountCalculator.evaluate("100+50*2")
Decimal('200.00')
>>> AmountCalculator.evaluate("foo")  # doctest: +IGNORE_EXCEPTION_DETAIL
Traceback (most recent call last:
  ...
ValueError: ...
"""
from __future__ import annotations

import re
from decimal import Decimal, ROUND_HALF_UP, getcontext
from typing import Final

# All intermediate math uses high-precision context (PRD §3.7.6).
getcontext().prec = 28

# Display / storage precision: 2 decimal places (cents)
_DISPLAY_QUANTUM: Final = Decimal("0.01")

# Whitelist: only digits, +-*/. and whitespace. No parentheses, no
# exponentiation, no comma. ``-`` doubled up (`--`) is also rejected
# because we forbid consecutive operators.
_WHITESPACE_RE: Final = re.compile(r"\s+")
_REJECTED_RE: Final = re.compile(r"[^0-9+\-*/.\s]")


class AmountCalculator:
    """Stateless helper. ``evaluate(expr) -> Decimal`` is the only API."""

    @staticmethod
    def evaluate(expression: str | None) -> Decimal:
        """Evaluate a whitelist arithmetic expression to a Decimal amount.

        Returns the value rounded to 2 decimal places (HALF_UP). Raises
        ``ValueError`` on:
        - empty / None expression
        - any non-whitelist character
        - consecutive binary operators (e.g. ``1++2``)
        - expression starting or ending with a binary operator
        - any other parse / arithmetic failure (division by zero etc.)
        """
        if expression is None:
            raise ValueError("empty expression")

        # Strip whitespace (caller stores the raw form untouched).
        cleaned = _WHITESPACE_RE.sub("", expression)
        if not cleaned:
            raise ValueError("empty expression after whitespace strip")

        if _REJECTED_RE.search(cleaned):
            raise ValueError("non-whitelisted character")

        _check_operator_order(cleaned)
        return _evaluate_clean(cleaned)

    @staticmethod
    def is_valid(expression: str | None) -> bool:
        """Boolean wrapper useful for UI feedback."""
        try:
            AmountCalculator.evaluate(expression)
            return True
        except ValueError:
            return False


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

_BINARY_OPS = ("+", "-", "*", "/")


def _check_operator_order(cleaned: str) -> None:
    """Reject malformed operator / dot sequences.

    Rules:
    - first char must be digit or '.'
    - last char must be digit
    - no consecutive binary operators (``1++2``)
    - no consecutive dots (``1..2``)
    """
    if cleaned[0] in _BINARY_OPS:
        raise ValueError("expression starts with a binary operator")
    if cleaned[-1] in _BINARY_OPS:
        raise ValueError("expression ends with a binary operator")

    for i, ch in enumerate(cleaned):
        prev = cleaned[i - 1] if i > 0 else ""
        if ch in _BINARY_OPS and prev in _BINARY_OPS:
            raise ValueError("two operators in a row")
        if ch == "." and prev == ".":
            raise ValueError("two dots in a row")


def _evaluate_clean(cleaned: str) -> Decimal:
    """Reduce ``cleaned`` to a single Decimal.

    Strategy: tokenise into numbers and operators. Walk terms with
    +/- precedence, then *// within each term. ``Decimal`` does the
    math. Errors bubble up as ValueError.
    """
    # Tokenise: a 'number' is one or more digits with at most one dot.
    tokens: list[str] = []
    i = 0
    while i < len(cleaned):
        ch = cleaned[i]
        if ch.isdigit() or ch == ".":
            j = i
            while j < len(cleaned) and (cleaned[j].isdigit() or cleaned[j] == "."):
                j += 1
            tokens.append(cleaned[i:j])
            i = j
        else:
            tokens.append(ch)
            i += 1

    if not tokens:
        raise ValueError("empty token list")

    # Walk with +/- precedence and *// within each term.
    total = Decimal("0")
    sign = 1  # cumulative additive sign for the current term
    acc: Decimal | None = None  # current term accumulator
    idx = 0

    # First token must be a number (guaranteed by _check_operator_order).
    first = tokens[idx]
    idx += 1
    try:
        acc = Decimal(first)
    except Exception as e:
        raise ValueError(f"bad number literal {first!r}") from e

    while idx < len(tokens):
        tok = tokens[idx]
        idx += 1
        if tok in ("+", "-"):
            # Flush current term into total.
            total += Decimal(sign) * (acc if acc is not None else Decimal("0"))
            sign = 1 if tok == "+" else -1
            acc = None
            if idx >= len(tokens):
                raise ValueError("expression ends with a binary operator")
            num_tok = tokens[idx]
            idx += 1
            try:
                acc = Decimal(num_tok)
            except Exception as e:
                raise ValueError(f"bad number literal {num_tok!r}") from e
        elif tok in ("*", "/"):
            if acc is None:
                raise ValueError("operator without preceding number")
            op = tok
            if idx >= len(tokens):
                raise ValueError("expression ends with a binary operator")
            rhs = tokens[idx]
            idx += 1
            try:
                rhs_dec = Decimal(rhs)
            except Exception as e:
                raise ValueError(f"bad number literal {rhs!r}") from e
            if op == "*":
                acc = acc * rhs_dec
            else:
                if rhs_dec == 0:
                    raise ValueError("division by zero")
                acc = acc / rhs_dec
        else:
            raise ValueError(f"unexpected token {tok!r}")

    total += Decimal(sign) * (acc if acc is not None else Decimal("0"))

    # Quantise to cents, half-up to match fiat accounting conventions.
    return total.quantize(_DISPLAY_QUANTUM, rounding=ROUND_HALF_UP)
