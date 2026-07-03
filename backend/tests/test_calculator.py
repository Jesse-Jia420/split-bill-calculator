"""Tests for the AmountCalculator service (v0.2.1 T01).

Coverage targets (PRD §3.6.1 + SPEC §3.6.1):
1. Whitelist rejection: ``foo``, ``350+5*``, ``350+abc``, ``(1+2)*3``
2. Decimal precision: ``0.1+0.2 == 0.30`` (no float drift), ``1.99+0.01 == 2.00``
3. Operator precedence: ``1+2*3 == 7.00``, ``100+50*2 == 200.00``
4. Linear division: ``350/5 == 70.00``, division by zero raises
5. Whitespace stripped: ``"  3 + 5 "`` accepted, output ``8.00``
6. Empty / None rejected
7. Consecutive operators rejected
8. API integration: POST /bills with ``amount_expression`` writes both
   ``amount`` and ``amount_expression``; reject 422 on bad expression
"""
from __future__ import annotations

from decimal import Decimal

import pytest
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient

from app.api import bills as bills_module
from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User
from app.main import app
from app.services.calculator import AmountCalculator


# ---------------------------------------------------------------------------
# Direct service tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "expr,expected",
    [
        ("350/5", Decimal("70.00")),
        ("100+50*2", Decimal("200.00")),
        ("0.1+0.2", Decimal("0.30")),
        ("10-3-2", Decimal("5.00")),
        ("5*2+1", Decimal("11.00")),
        ("10/4", Decimal("2.50")),
        ("0.5*3.5", Decimal("1.75")),
        ("  3 + 5 ", Decimal("8.00")),  # whitespace stripped
        ("1+2*3-4/2", Decimal("5.00")),
        ("1.99+0.01", Decimal("2.00")),
        ("9999999.99", Decimal("9999999.99")),
        ("0.99*100", Decimal("99.00")),
    ],
)
def test_calculator_valid(expr: str, expected: Decimal) -> None:
    """Spec §3.6.1: linear 4-op expressions with Decimal precision."""
    result = AmountCalculator.evaluate(expr)
    assert result == expected, f"{expr!r} -> {result}, expected {expected}"


@pytest.mark.parametrize(
    "expr",
    [
        "foo",
        "350+5*",
        "350+abc",
        "(1+2)*3",
        "",
        "   ",
        "1++2",
        "1..2",
        "1/0",
        "abc",
        "1.2.3",
        None,
        "3-",
        "+5",
        "5+",
        "*",
        "**",
        "100^2",
        "abc; rm -rf /",
    ],
)
def test_calculator_invalid(expr) -> None:
    """Whitelist rejection + structural failure modes."""
    with pytest.raises(ValueError):
        AmountCalculator.evaluate(expr)


def test_calculator_is_valid_wrapper() -> None:
    assert AmountCalculator.is_valid("350/5") is True
    assert AmountCalculator.is_valid("foo") is False
    assert AmountCalculator.is_valid("") is False
    assert AmountCalculator.is_valid(None) is False


def test_calculator_quantises_to_two_decimals() -> None:
    """1.005 should round to 1.01 (HALF_UP) not 1.00."""
    # Construct an expression whose exact Decimal result is 1.005.
    # 1005/1000 = 1.005 -> quantize HALF_UP gives 1.01.
    result = AmountCalculator.evaluate("1005/1000")
    assert result == Decimal("1.01"), f"got {result}"


def test_calculator_no_float_drift() -> None:
    """0.1 + 0.2 == 0.30 (Decimal), not 0.30000000000000004 (float)."""
    result = AmountCalculator.evaluate("0.1+0.2")
    assert isinstance(result, Decimal)
    assert result == Decimal("0.30")


# ---------------------------------------------------------------------------
# API integration tests (bills amount_expression)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate():
    db = SessionLocal()
    try:
        from app.db.models.bill_participants import BillParticipant
        from app.db.models.verification_codes import VerificationCode
        db.query(BillParticipant).delete()
        db.query(Bill).delete()
        db.query(SessionMember).delete()
        db.query(SessionModel).delete()
        db.query(AuthToken).delete()
        db.query(VerificationCode).delete()
        db.query(User).delete()
        db.commit()
    finally:
        db.close()
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _make_user(email: str, default_name: str | None = None) -> User:
    db = SessionLocal()
    try:
        existing = db.query(User).filter_by(email=email).first()
        if existing is not None:
            return existing
        user = User(
            email=email,
            default_name=default_name or email.split("@")[0][:120],
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        db.close()


def _make_session(owner: User, name: str = "Test session") -> tuple[SessionModel, SessionMember]:
    db = SessionLocal()
    try:
        s = SessionModel(
            name=name,
            owner_user_id=owner.id,
            invite_token="t" + str(owner.id),
            invite_expires_at=None,
            invite_created_at=None,
        )
        db.add(s)
        db.flush()
        sm = SessionMember(
            session_id=s.id,
            user_id=owner.id,
            display_name=owner.default_name,
            role=SessionRole.OWNER.value,
        )
        db.add(sm)
        db.commit()
        db.refresh(s)
        db.refresh(sm)
        return s, sm
    finally:
        db.close()


def _login_token(user: User) -> str:
    """Mint an AuthToken + return its raw value so client can set cookie."""
    db = SessionLocal()
    try:
        raw = "test-raw-" + str(user.id)
        token_hash = hash_token(raw)
        tok = AuthToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        db.add(tok)
        db.commit()
        db.refresh(tok)
        return raw
    finally:
        db.close()


def _client_with_cookie(client: TestClient, user: User) -> TestClient:
    raw = _login_token(user)
    client.cookies.set(COOKIE_NAME, raw)
    return client


@pytest.fixture
def setup(client: TestClient):
    user = _make_user("alice@sbc.test", "Alice")
    session, sm = _make_session(user)
    _client_with_cookie(client, user)
    return client, user, session, sm


def test_create_bill_with_calculator_expression(setup) -> None:
    """POST /bills with use_calculator=true + amount_expression writes both fields."""
    client, user, session, sm = setup
    resp = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 999,  # ignored because use_calculator=true
            "payer_member_id": sm.id,
            "description": "taxi AA",
            "occurred_at": "2026-07-03T10:00:00+00:00",
            "currency": "CNY",
            "use_calculator": True,
            "amount_expression": "350/5",
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["amount"] == pytest.approx(70.0)
    assert body["amount_expression"] == "350/5"


def test_create_bill_without_calculator(setup) -> None:
    """POST /bills without use_calculator leaves amount_expression NULL."""
    client, user, session, sm = setup
    resp = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 123.45,
            "payer_member_id": sm.id,
            "description": "lunch",
            "occurred_at": "2026-07-03T10:00:00+00:00",
            "currency": "CNY",
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["amount"] == pytest.approx(123.45)
    assert body["amount_expression"] is None


def test_create_bill_rejects_invalid_expression(setup) -> None:
    """POST /bills with malformed expression → 422."""
    client, user, session, sm = setup
    resp = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 100,
            "payer_member_id": sm.id,
            "description": "test",
            "occurred_at": "2026-07-03T10:00:00+00:00",
            "currency": "CNY",
            "use_calculator": True,
            "amount_expression": "foo",  # non-whitelisted
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    assert resp.status_code == 422, resp.text
    # The pydantic field_validator catches the bad chars; error key references them.
    detail = resp.json().get("detail", [])
    if isinstance(detail, list):
        # pydantic validation error format
        msg = "\n".join(
            str(d.get("msg", "")) for d in detail
        )
        assert "whitelist" in msg.lower() or "amount_expression" in msg.lower()
    else:
        # either error
        assert "whitelist" in str(detail).lower() or "ai_unavailable" in str(detail)


def test_create_bill_rejects_use_calculator_with_empty_expression(setup) -> None:
    """use_calculator=true but empty expression → 422."""
    client, user, session, sm = setup
    resp = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 100,
            "payer_member_id": sm.id,
            "description": "test",
            "occurred_at": "2026-07-03T10:00:00+00:00",
            "currency": "CNY",
            "use_calculator": True,
            "amount_expression": "",  # empty
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    assert resp.status_code == 422, resp.text


def test_update_bill_with_calculator_expression(setup) -> None:
    """PATCH /bills/{id} with amount_expression updates both fields."""
    client, user, session, sm = setup
    # Create a baseline bill.
    create = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 100,
            "payer_member_id": sm.id,
            "description": "first",
            "occurred_at": "2026-07-03T10:00:00+00:00",
            "currency": "CNY",
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    assert create.status_code == 201
    bill_id = create.json()["id"]

    # PATCH with amount_expression.
    update = client.patch(
        f"/sessions/{session.id}/bills/{bill_id}",
        json={
            "amount_expression": "200*1.5",
        },
    )
    assert update.status_code == 200, update.text
    body = update.json()
    assert body["amount"] == pytest.approx(300.0)
    assert body["amount_expression"] == "200*1.5"


def test_update_bill_rejects_invalid_expression(setup) -> None:
    """PATCH with malformed expression → 422."""
    client, user, session, sm = setup
    create = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 100,
            "payer_member_id": sm.id,
            "description": "first",
            "occurred_at": "2026-07-03T10:00:00+00:00",
            "currency": "CNY",
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    bill_id = create.json()["id"]

    update = client.patch(
        f"/sessions/{session.id}/bills/{bill_id}",
        json={"amount_expression": "1++2"},  # consecutive ops
    )
    assert update.status_code == 422, update.text


# ---------------------------------------------------------------------------
# T02 — last_bill_participants on session detail
# ---------------------------------------------------------------------------


def test_session_detail_includes_last_bill_participants(setup) -> None:
    """POST /sessions/{id} returns last_bill_participants from the latest bill."""
    client, user, session, sm = setup
    # Create a bill with explicit participants.
    create = client.post(
        f"/sessions/{session.id}/bills",
        json={
            "amount": 99,
            "payer_member_id": sm.id,
            "description": "test",
            "occurred_at": "2026-07-03T12:00:00+00:00",
            "currency": "CNY",
            "participants": [{"member_id": sm.id, "is_exclusive": False, "exclusive_amount": 0}],
        },
    )
    assert create.status_code == 201

    detail = client.get(f"/sessions/{session.id}")
    assert detail.status_code == 200
    body = detail.json()
    assert "last_bill_participants" in body
    assert body["last_bill_participants"] == [sm.id]


def test_session_detail_last_bill_participants_null_when_empty(setup) -> None:
    """last_bill_participants is null when the session has no bills."""
    client, user, session, sm = setup
    detail = client.get(f"/sessions/{session.id}")
    assert detail.status_code == 200
    body = detail.json()
    assert body.get("last_bill_participants") is None
