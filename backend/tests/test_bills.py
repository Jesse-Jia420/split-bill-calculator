"""Tests for the T10 (bills CRUD) + T11 (bills/parse AI-assist) API.

Strategy
--------
- Each test starts from a clean DB (autouse fixture truncates bills +
  sessions + members + auth + users + verification_codes).
- "Logged-in" users are minted by inserting User + AuthToken + raw
  cookie, mirroring test_sessions.py.
- For multi-member scenarios we insert SessionMember rows directly
  (bypassing the invite flow) to keep tests focused on bills logic.
- MiniMax API is mocked by monkeypatching `app.api.bills._call_minimax_api`
  so we never call the real network. The mock is async.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import bills as bills_module
from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.users import User
from app.db.models.verification_codes import (
    VerificationCode,
    VerificationPurpose,
)
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


# v0.2.2 anti-pattern #53b: skip truncate when SBC_SKIP_TEST_TRUNCATE=1
@pytest.fixture(autouse=True)
def _truncate_all():
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return
    """Reset all tables between tests."""
    db = SessionLocal()
    try:
        # Order matters: child rows first.
        db.query(BillParticipant).delete()
        db.query(Bill).delete()
        db.query(SessionMember).delete()
        db.query(SessionExchangeRate).delete()
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
    """Idempotent user creation."""
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


def _login_as(email: str) -> tuple[TestClient, User]:
    """Insert user + auth_token row, return (client, user)."""
    user = _make_user(email)
    raw = secrets.token_urlsafe(32)
    db = SessionLocal()
    try:
        db.add(
            AuthToken(
                user_id=user.id,
                token_hash=hash_token(raw),
                expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            )
        )
        db.commit()
    finally:
        db.close()

    c = TestClient(app)
    c.cookies.set(COOKIE_NAME, raw)
    return c, user


def _ensure_user(email: str, default_name: str | None = None) -> None:
    """Idempotently insert a user."""
    db = SessionLocal()
    try:
        existing = db.query(User).filter_by(email=email).first()
        if existing is None:
            db.add(User(email=email, default_name=default_name or email.split("@")[0][:120]))
            db.commit()
    finally:
        db.close()


def _make_session_with_members(
    owner_email: str = "alice@bills.local",
    member_emails: list[tuple[str, str]] | None = None,
    session_name: str = "Bangkok 2026-07",
) -> tuple[int, dict[str, int]]:
    """Create a session with N members; returns (session_id, {email: member_id}).

    Auto-creates any users that do not yet exist (idempotent).
    """
    _ensure_user(owner_email, "Alice")
    if member_emails:
        for email, _name in member_emails:
            _ensure_user(email)

    db = SessionLocal()
    try:
        owner = db.query(User).filter_by(email=owner_email).one()
        from datetime import datetime, timedelta, timezone
        import secrets as _secrets
        _now = datetime.now(timezone.utc)
        session = SessionModel(
            name=session_name,
            owner_user_id=owner.id,
            invite_token=_secrets.token_urlsafe(32),
            invite_expires_at=_now + timedelta(days=30),
            invite_created_at=_now,
            session_code=_secrets.token_hex(4),
        )
        db.add(session)
        db.flush()
        owner_sm = SessionMember(
            session_id=session.id,
            user_id=owner.id,
            display_name="Alice",
            role=SessionRole.OWNER.value,
        )
        db.add(owner_sm)
        db.flush()
        out: dict[str, int] = {owner_email: owner_sm.id}

        if member_emails:
            for email, name in member_emails:
                u = db.query(User).filter_by(email=email).one()
                sm = SessionMember(
                    session_id=session.id,
                    user_id=u.id,
                    display_name=name,
                    role=SessionRole.MEMBER.value,
                )
                db.add(sm)
                db.flush()
                out[email] = sm.id
        db.commit()
        return session.id, out
    finally:
        db.close()


def _make_5_member_session() -> tuple[int, dict[str, int]]:
    """5 members: Alice (owner), Bob, Carol, Dave, Eve."""
    return _make_session_with_members(
        owner_email="alice@bills.local",
        member_emails=[
            ("bob@bills.local", "Bob"),
            ("carol@bills.local", "Carol"),
            ("dave@bills.local", "Dave"),
            ("eve@bills.local", "Eve"),
        ],
    )


def _bill_payload(
    *,
    payer_member_id: int,
    member_ids: list[int],
    amount: float = 1000.0,
    description: str = "晚餐",
    occurred_at: str = "2026-06-30T19:00:00+00:00",
    exclusive: dict[int, float] | None = None,
    currency: str = "CNY",
) -> dict[str, Any]:
    """Build a POST /bills body."""
    excl = exclusive or {}
    return {
        "amount": amount,
        "payer_member_id": payer_member_id,
        "description": description,
        "occurred_at": occurred_at,
        "currency": currency,
        "participants": [
            {
                "member_id": mid,
                "is_exclusive": mid in excl,
                "exclusive_amount": excl.get(mid, 0.0),
            }
            for mid in member_ids
        ],
    }


# ---------------------------------------------------------------------------
# T10: Pure-function tests for share_amount derivation
# ---------------------------------------------------------------------------


class TestShareAmountDerivation:
    """PRD §3.1.2 formula: shared_pool = amount - sum(exclusive) ... etc."""

    def test_no_exclusive_equal_split(self) -> None:
        from app.api.bills import ParticipantIn, _compute_share_amounts

        parts = [
            ParticipantIn(member_id=1, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=2, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=3, is_exclusive=False, exclusive_amount=0),
        ]
        out = _compute_share_amounts(300.0, parts)
        assert out == [100.0, 100.0, 100.0]

    def test_one_exclusive_member(self) -> None:
        from app.api.bills import ParticipantIn, _compute_share_amounts

        parts = [
            ParticipantIn(member_id=1, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=2, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=3, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=4, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=5, is_exclusive=True, exclusive_amount=200.0),
        ]
        out = _compute_share_amounts(1000.0, parts)
        # shared_pool = 800, per_user_shared = 160
        assert out == [160.0, 160.0, 160.0, 160.0, 360.0]

    def test_multiple_exclusive_members(self) -> None:
        from app.api.bills import ParticipantIn, _compute_share_amounts

        parts = [
            ParticipantIn(member_id=1, is_exclusive=True, exclusive_amount=50.0),
            ParticipantIn(member_id=2, is_exclusive=False, exclusive_amount=0),
            ParticipantIn(member_id=3, is_exclusive=True, exclusive_amount=80.0),
        ]
        out = _compute_share_amounts(500.0, parts)
        # v0.2.2 (T07): the algorithm now quantises per-participant share
        # to cents via Decimal + ROUND_HALF_UP. shared_pool = 500 - 130 = 370,
        # per_user_shared = 370/3 → 123.333... rounds to 123.33.
        # m1 = 123.33 + 50 = 173.33
        # m2 = 123.33
        # m3 = 123.33 + 80 = 203.33
        assert out == [173.33, 123.33, 203.33], (
            f"_compute_share_amounts should round to cents per participant; got {out}"
        )
        # Total consumed equals bill amount (rounding residual stays <= 0.03).
        assert abs(sum(out) - 500.0) < 0.05

    def test_empty_returns_empty(self) -> None:
        from app.api.bills import _compute_share_amounts

        assert _compute_share_amounts(100.0, []) == []


# ---------------------------------------------------------------------------
# T10: POST /sessions/{id}/bills
# ---------------------------------------------------------------------------


class TestCreateBill:
    def test_create_simple_bill_no_exclusive(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids[e] for e in mids],
            amount=1000.0,
            description="晚餐",
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201, r.text
        bill = r.json()
        assert bill["amount"] == 1000.0
        assert bill["currency"] == "CNY"
        assert bill["payer_id"] == mids["alice@bills.local"]
        assert bill["description"] == "晚餐"
        assert bill["status"] == "draft"
        assert len(bill["participants"]) == 5
        # share_amount = 1000 / 5 = 200 each
        for p in bill["participants"]:
            assert p["share_amount"] == 200.0
            assert p["is_exclusive"] is False
            assert p["exclusive_amount"] == 0.0

    def test_create_bill_with_one_exclusive(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids[e] for e in mids],
            amount=1000.0,
            exclusive={mids["eve@bills.local"]: 200.0},
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201, r.text
        bill = r.json()
        eve_share = next(
            p for p in bill["participants"] if p["member_id"] == mids["eve@bills.local"]
        )
        # shared_pool = 800, per_user_shared = 160, eve = 160 + 200 = 360
        assert eve_share["share_amount"] == 360.0
        assert eve_share["is_exclusive"] is True
        assert eve_share["exclusive_amount"] == 200.0

    def test_create_bill_requires_positive_amount(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=0.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 422  # pydantic gt=0

    def test_create_bill_rejects_non_member_payer(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=9999,  # bogus
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 400, r.text
        assert "payer_member_id" in r.json()["detail"]["error"]

    def test_create_bill_rejects_non_member_participant(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], 9999],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 400
        assert "is not a session member" in r.json()["detail"]["error"]

    def test_create_bill_rejects_exclusive_exceeds_amount(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
            exclusive={mids["bob@bills.local"]: 200.0},
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 400
        assert "exceeds" in r.json()["detail"]["error"]

    def test_create_bill_rejects_exclusive_zero_amount(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
            exclusive={mids["bob@bills.local"]: 0.0},
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        # pydantic field_validator raises on (is_exclusive=True, exclusive_amount=0)
        assert r.status_code == 422

    def test_create_bill_rejects_exclusive_amount_with_flag_false(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
            exclusive={mids["bob@bills.local"]: 50.0},
        )
        # Manually flip is_exclusive to false to test validator
        body["participants"][1]["is_exclusive"] = False
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 422

    def test_create_bill_rejects_duplicate_participants(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["alice@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 400
        assert "duplicate" in r.json()["detail"]["error"]

    def test_create_bill_requires_nonempty_participants(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"]],
            amount=100.0,
        )
        body["participants"] = []
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 422  # pydantic min_length=1

    def test_create_bill_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.post("/sessions/1/bills", json={})
        assert r.status_code == 401

    def test_create_bill_non_member_returns_403(self, client: TestClient) -> None:
        # Frank is NOT in the 5-member session.
        c, _ = _login_as("alice@bills.local")
        sid_a, mids_a = _make_5_member_session()
        frank, _ = _login_as("frank@bills.local")
        body = _bill_payload(
            payer_member_id=mids_a["alice@bills.local"],
            member_ids=[mids_a["alice@bills.local"]],
            amount=100.0,
        )
        r = frank.post(f"/sessions/{sid_a}/bills", json=body)
        assert r.status_code == 403

    def test_create_bill_persists_to_db(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=200.0,
            description="Taxi",
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201
        bid = r.json()["id"]

        db = SessionLocal()
        try:
            bill = db.query(Bill).filter_by(id=bid).one()
            assert bill.amount == 200.0
            assert bill.status == "draft"
            assert bill.created_by is not None
            parts = db.query(BillParticipant).filter_by(bill_id=bid).all()
            assert len(parts) == 2
        finally:
            db.close()

    def test_create_bill_currency_normalised(self, client: TestClient) -> None:
        """Lowercase "usd" should be normalised to "USD" on insert.

        v0.2.2 (T10): the session must accept USD as a currency (the
        default helper session is CNY-only). We mint a dual-currency
        session explicitly so the "USD" bill is accepted.
        """
        from decimal import Decimal
        c, _ = _login_as("alice@bills.local")
        # v0.2.2 (T10): create a CNY+USD session via the public API so
        # the test exercises the same code path real users do.
        resp = c.post(
            "/sessions",
            json={
                "name": "USD test",
                "currencies": ["CNY", "USD"],
                "primary_currency": "CNY",
                "exchange_rates": [
                    {"from_currency": "USD", "to_currency": "CNY", "rate": "7.20"},
                ],
            },
        )
        assert resp.status_code == 201, resp.text
        sid = resp.json()["id"]
        # Look up any member id from the post-facto list endpoint.
        mids_resp = c.get(f"/sessions/{sid}")
        members = mids_resp.json()["members"]
        alice_mid = members[0]["id"]

        body = _bill_payload(
            payer_member_id=alice_mid,
            member_ids=[alice_mid],
            amount=50.0,
            currency="usd",
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201, r.text
        assert r.json()["currency"] == "USD"


# ---------------------------------------------------------------------------
# T10: GET /sessions/{id}/bills
# ---------------------------------------------------------------------------


class TestListBills:
    def test_list_empty(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()
        r = c.get(f"/sessions/{sid}/bills")
        assert r.status_code == 200
        assert r.json() == []

    def test_list_orders_by_occurred_at_desc(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()

        # Insert 2 bills with different occurred_at
        for ts, descr in [
            ("2026-06-29T12:00:00+00:00", "午餐"),
            ("2026-06-30T19:00:00+00:00", "晚餐"),
        ]:
            body = _bill_payload(
                payer_member_id=mids["alice@bills.local"],
                member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
                amount=100.0,
                description=descr,
                occurred_at=ts,
            )
            r = c.post(f"/sessions/{sid}/bills", json=body)
            assert r.status_code == 201

        r = c.get(f"/sessions/{sid}/bills")
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 2
        assert body[0]["description"] == "晚餐"  # newer first
        assert body[1]["description"] == "午餐"

    def test_list_includes_share_amount(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=300.0,
            exclusive={mids["bob@bills.local"]: 60.0},
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201

        r = c.get(f"/sessions/{sid}/bills")
        assert r.status_code == 200
        bill = r.json()[0]
        bob_p = next(p for p in bill["participants"] if p["member_id"] == mids["bob@bills.local"])
        alice_p = next(p for p in bill["participants"] if p["member_id"] == mids["alice@bills.local"])
        # shared_pool = 240; per_user_shared = 120; alice = 120; bob = 120 + 60 = 180
        assert alice_p["share_amount"] == 120.0
        assert bob_p["share_amount"] == 180.0

    def test_list_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.get("/sessions/1/bills")
        assert r.status_code == 401

    def test_list_non_member_returns_403(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()
        # Frank is NOT in this session.
        frank, _ = _login_as("frank@bills.local")
        r = frank.get(f"/sessions/{sid}/bills")
        assert r.status_code == 403

    def test_list_isolated_to_session(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid1, mids1 = _make_5_member_session()
        sid2, mids2 = _make_session_with_members(
            owner_email="alice@bills.local",
            member_emails=[("bob@bills.local", "Bob")],
        )

        # Insert bill in session 1
        body = _bill_payload(
            payer_member_id=mids1["alice@bills.local"],
            member_ids=[mids1["alice@bills.local"]],
            amount=100.0,
            description="s1-bill",
        )
        r = c.post(f"/sessions/{sid1}/bills", json=body)
        assert r.status_code == 201

        # Insert bill in session 2
        body = _bill_payload(
            payer_member_id=mids2["alice@bills.local"],
            member_ids=[mids2["alice@bills.local"]],
            amount=200.0,
            description="s2-bill",
        )
        r = c.post(f"/sessions/{sid2}/bills", json=body)
        assert r.status_code == 201

        r1 = c.get(f"/sessions/{sid1}/bills")
        r2 = c.get(f"/sessions/{sid2}/bills")
        assert len(r1.json()) == 1 and r1.json()[0]["description"] == "s1-bill"
        assert len(r2.json()) == 1 and r2.json()[0]["description"] == "s2-bill"


# ---------------------------------------------------------------------------
# T10: PATCH /sessions/{id}/bills/{bill_id}
# ---------------------------------------------------------------------------


class TestUpdateBill:
    def test_owner_updates_amount(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        # v0.2.2 (T10): CNY-only default session rejects USD, so the
        # PATCH now needs a session that supports USD. Reuse the
        # helper to keep the test's intent (owner updates amount)
        # obvious while honoring v0.2.2 currency constraints.
        resp = c.post(
            "/sessions",
            json={
                "name": "USD test update",
                "currencies": ["CNY", "USD"],
                "primary_currency": "CNY",
                "exchange_rates": [
                    {"from_currency": "USD", "to_currency": "CNY", "rate": "7.20"},
                ],
            },
        )
        assert resp.status_code == 201, resp.text
        sid = resp.json()["id"]
        members = c.get(f"/sessions/{sid}").json()["members"]
        alice_mid = members[0]["id"]

        body = _bill_payload(
            payer_member_id=alice_mid,
            member_ids=[alice_mid],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201, r.text
        bid = r.json()["id"]

        r = c.patch(f"/sessions/{sid}/bills/{bid}", json={"amount": 250.0, "currency": "USD"})
        assert r.status_code == 200, r.text
        updated = r.json()
        assert updated["amount"] == 250.0
        assert updated["currency"] == "USD"
        # v0.2.2 (T10): a fresh snapshot should be present (USD → CNY).
        assert updated["exchange_rate_snapshot"] is not None

    def test_non_creator_can_update_returns_200(self, client: TestClient) -> None:
        # v0.1.2 (T17): any session member can update a bill -- the
        # previous 'only the creator' 403 guard is removed. Alice creates
        # the bill, Bob (another member) successfully edits the amount.
        c_alice, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c_alice.post(f"/sessions/{sid}/bills", json=body)
        assert r.status_code == 201
        bid = r.json()["id"]

        c_bob, _ = _login_as("bob@bills.local")
        r = c_bob.patch(f"/sessions/{sid}/bills/{bid}", json={"amount": 200.0})
        assert r.status_code == 200, r.text
        assert r.json()["amount"] == 200.0

    def test_update_bill_cannot_change_description(self, client: TestClient) -> None:
        # v0.1.2 (T17): `description` is immutable. PATCH that includes
        # `description` (or any other unknown field) is rejected with
        # 422 by Pydantic `extra='forbid'`.
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
            description="Original",
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        r = c.patch(f"/sessions/{sid}/bills/{bid}", json={"description": "Hacked"})
        assert r.status_code == 422, r.text

        # And the description is still the original.
        r = c.get(f"/sessions/{sid}/bills")
        assert r.json()[0]["description"] == "Original"

    def test_update_bill_unknown_field_returns_422(self, client: TestClient) -> None:
        # extra='forbid' should reject any unknown field, not just description.
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        r = c.patch(f"/sessions/{sid}/bills/{bid}", json={"totally_made_up": "value"})
        assert r.status_code == 422, r.text

    def test_update_bill_non_member_returns_403(self, client: TestClient) -> None:
        # Even though any member can edit, a non-member still gets 403.
        c_alice, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c_alice.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        # Frank is a real user but not a member of this session.
        c_frank, _ = _login_as("frank@bills.local")
        r = c_frank.patch(f"/sessions/{sid}/bills/{bid}", json={"amount": 200.0})
        assert r.status_code == 403
        assert "member" in r.json()["detail"]["error"]

    def test_nonexistent_bill_returns_404(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()
        r = c.patch(f"/sessions/{sid}/bills/99999", json={"amount": 100.0})
        assert r.status_code == 404

    def test_update_participants_replaces_wholesale(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        # Now replace participants with all 5 members + an exclusive
        new_body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids[e] for e in mids],
            amount=200.0,
            exclusive={mids["eve@bills.local"]: 50.0},
        )
        r = c.patch(f"/sessions/{sid}/bills/{bid}", json={"participants": new_body["participants"]})
        assert r.status_code == 200, r.text
        updated = r.json()
        assert len(updated["participants"]) == 5
        eve_share = next(p for p in updated["participants"] if p["member_id"] == mids["eve@bills.local"])
        # amount stays at 100 (PATCH only sends participants, not amount).
        # shared_pool = 100 - 50 = 50; per_user_shared = 50/5 = 10; eve = 10 + 50 = 60.
        assert eve_share["share_amount"] == 60.0

    def test_update_participants_validates_total(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        # Try to add an exclusive larger than the bill amount
        bad_body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
            exclusive={mids["bob@bills.local"]: 150.0},
        )
        r = c.patch(f"/sessions/{sid}/bills/{bid}", json={"participants": bad_body["participants"]})
        assert r.status_code == 400

    def test_update_only_one_field_works(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
            description="Original",
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        r = c.patch(f"/sessions/{sid}/bills/{bid}", json={"occurred_at": "2026-07-01T12:00:00+00:00"})
        assert r.status_code == 200
        assert r.json()["occurred_at"].startswith("2026-07-01T12:00:00")
        assert r.json()["amount"] == 100.0  # unchanged

    def test_update_nonexistent_session_returns_403(self, client: TestClient) -> None:
        # Caller is a member of session X but not of session Y in URL.
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        r = c.patch(f"/sessions/{sid + 9999}/bills/{bid}", json={"amount": 200.0})
        assert r.status_code == 403  # not a member of fake session


# ---------------------------------------------------------------------------
# T10: DELETE /sessions/{id}/bills/{bill_id}
# ---------------------------------------------------------------------------


class TestDeleteBill:
    def test_creator_deletes(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        r = c.delete(f"/sessions/{sid}/bills/{bid}")
        assert r.status_code == 204, r.text

        # Verify gone
        r = c.get(f"/sessions/{sid}/bills")
        assert r.json() == []

        db = SessionLocal()
        try:
            assert db.query(Bill).filter_by(id=bid).first() is None
            assert db.query(BillParticipant).filter_by(bill_id=bid).first() is None
        finally:
            db.close()

    def test_non_creator_can_delete_returns_204(self, client: TestClient) -> None:
        # v0.1.2 (T17): any session member can delete a bill.
        c_alice, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c_alice.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        c_bob, _ = _login_as("bob@bills.local")
        r = c_bob.delete(f"/sessions/{sid}/bills/{bid}")
        assert r.status_code == 204, r.text

    def test_delete_bill_non_member_returns_403(self, client: TestClient) -> None:
        # Non-member still 403 (even though the v0.1.0 'creator-only'
        # gate is gone, session membership is still required).
        c_alice, _ = _login_as("alice@bills.local")
        sid, mids = _make_5_member_session()
        body = _bill_payload(
            payer_member_id=mids["alice@bills.local"],
            member_ids=[mids["alice@bills.local"], mids["bob@bills.local"]],
            amount=100.0,
        )
        r = c_alice.post(f"/sessions/{sid}/bills", json=body)
        bid = r.json()["id"]

        c_frank, _ = _login_as("frank@bills.local")
        r = c_frank.delete(f"/sessions/{sid}/bills/{bid}")
        assert r.status_code == 403

    def test_nonexistent_bill_returns_404(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()
        r = c.delete(f"/sessions/{sid}/bills/99999")
        assert r.status_code == 404

    def test_delete_no_auth_returns_403(self, client: TestClient) -> None:
        """§3.12 (v0.3.2): DELETE /bills/{id} now accepts anonymous access
        via ``X-Nickname-Secret``. A request with NO auth (no cookie + no
        secret header) is therefore rejected with **403** (not a session
        member), not 401 (please authenticate).

        Pre-v0.3.2 this test asserted 401 because the BE dep was
        ``get_session_member`` which depends on ``get_current_user`` and
        bubbles up a 401 when the caller has no cookie. After upgrading
        to ``get_session_member_or_secret`` the dep uses
        ``get_optional_user`` and surfaces a 403 for the same request
        shape, matching SPEC §3.12.E.1 "no secret / wrong secret → 403".
        """
        r = client.delete("/sessions/1/bills/1")
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# T11: POST /sessions/{id}/bills/parse
# ---------------------------------------------------------------------------


class TestParseBill:
    async def test_parse_returns_200_with_hints(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()

        async def fake_call(text: str, member_names: list[str]) -> dict:
            return {
                "amount": 350.0,
                "payer_hint": "self",
                "participants_hint": ["all"],
                "description": "打车",
            }

        # Patch the inner async function used by the endpoint.
        monkey = pytest.MonkeyPatch()
        monkey.setattr(bills_module, "_call_minimax_api", fake_call)
        try:
            r = c.post(f"/sessions/{sid}/bills/parse", json={"text": "刚才打车 350 我付的 AA 我们 5 个"})
        finally:
            monkey.undo()

        assert r.status_code == 200, r.text
        body = r.json()
        assert body["amount"] == 350.0
        assert body["payer_hint"] == "self"
        assert body["participants_hint"] == ["all"]
        assert body["description"] == "打车"

    def test_parse_does_not_write_to_db(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()

        async def fake_call(text: str, member_names: list[str]) -> dict:
            return {
                "amount": 100.0,
                "payer_hint": "self",
                "participants_hint": ["all"],
                "description": "x",
            }

        monkey = pytest.MonkeyPatch()
        monkey.setattr(bills_module, "_call_minimax_api", fake_call)
        try:
            r = c.post(f"/sessions/{sid}/bills/parse", json={"text": "something"})
        finally:
            monkey.undo()
        assert r.status_code == 200

        # No bill rows should exist.
        r = c.get(f"/sessions/{sid}/bills")
        assert r.json() == []

    def test_parse_no_api_key_returns_422(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()

        # settings.minimax_api_key is "" by default in dev -> 422 ai_unavailable
        r = c.post(f"/sessions/{sid}/bills/parse", json={"text": "something"})
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["error"] == "ai_unavailable"

    def test_parse_api_failure_returns_422(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()

        async def fake_call(text: str, member_names: list[str]) -> dict:
            raise ValueError("ai_unavailable")

        monkey = pytest.MonkeyPatch()
        monkey.setattr(bills_module, "_call_minimax_api", fake_call)
        try:
            r = c.post(f"/sessions/{sid}/bills/parse", json={"text": "x"})
        finally:
            monkey.undo()
        assert r.status_code == 422
        assert r.json()["detail"]["error"] == "ai_unavailable"

    def test_parse_schema_violation_returns_422(self, client: TestClient) -> None:
        """If the model returns malformed JSON, we surface 422."""

        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()

        async def fake_call(text: str, member_names: list[str]) -> dict:
            raise ValueError("ai_unavailable")  # _call_minimax_api internally raises

        monkey = pytest.MonkeyPatch()
        monkey.setattr(bills_module, "_call_minimax_api", fake_call)
        try:
            r = c.post(f"/sessions/{sid}/bills/parse", json={"text": "x"})
        finally:
            monkey.undo()
        assert r.status_code == 422

    def test_parse_missing_text_returns_422(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()
        r = c.post(f"/sessions/{sid}/bills/parse", json={})
        assert r.status_code == 422  # pydantic

    def test_parse_non_member_returns_403(self, client: TestClient) -> None:
        c, _ = _login_as("alice@bills.local")
        sid, _ = _make_5_member_session()
        # Default session members are alice/bob/carol/dave/eve from the helper;
        # use an email that is definitely NOT in the session.
        outsider, _ = _login_as("outsider@bills.local")
        r = outsider.post(f"/sessions/{sid}/bills/parse", json={"text": "x"})
        assert r.status_code == 403

    def test_parse_no_auth_returns_403(self, client: TestClient) -> None:
        """§3.12 (v0.3.2): POST /bills/parse now accepts anonymous access
        via ``X-Nickname-Secret``. No auth at all → **403** (you're not a
        session member), not 401. Mirrors the DELETE test above — see
        that docstring for the full behavioural rationale.
        """
        r = client.post("/sessions/1/bills/parse", json={"text": "x"})
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# T11: _call_minimax_api direct unit tests (no FastAPI / DB).
# ---------------------------------------------------------------------------


class TestCallMinimaxApiUnit:
    """Direct unit tests for the AI integration helper.

    These don't go through HTTP — they exercise the parsing +
    schema-validation logic. We monkeypatch httpx to inject fake
    responses so we never touch the real network.
    """

    async def test_returns_parsed_dict_on_valid_response(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Set a fake key so the "no key" guard passes.
        monkeypatch.setattr(bills_module.settings, "minimax_api_key", "test-key", raising=False)

        class FakeResp:
            status_code = 200

            def json(self) -> dict:
                return {
                    "choices": [
                        {"message": {"content": '{"amount": 100, "payer_hint": "self", "participants_hint": ["all"], "description": "lunch"}'}}
                    ]
                }

        class FakeClient:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            async def __aenter__(self) -> "FakeClient":
                return self

            async def __aexit__(self, *args: Any) -> None:
                pass

            async def post(self, url: str, **kwargs: Any) -> FakeResp:
                return FakeResp()

        monkeypatch.setattr(bills_module.httpx, "AsyncClient", FakeClient)
        out = await bills_module._call_minimax_api("test text", ["Alice", "Bob"])
        assert out == {
            "amount": 100.0,
            "payer_hint": "self",
            "participants_hint": ["all"],
            "description": "lunch",
        }

    async def test_raises_ai_unavailable_when_no_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(bills_module.settings, "minimax_api_key", "", raising=False)
        with pytest.raises(ValueError, match="ai_unavailable"):
            await bills_module._call_minimax_api("x", [])

    async def test_raises_ai_unavailable_on_malformed_json(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(bills_module.settings, "minimax_api_key", "test-key", raising=False)

        class FakeResp:
            status_code = 200

            def json(self) -> dict:
                return {"choices": [{"message": {"content": "not json at all"}}]}

        class FakeClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass
            async def __aenter__(self) -> "FakeClient":
                return self
            async def __aexit__(self, *a: Any) -> None:
                pass
            async def post(self, url: str, **kw: Any) -> FakeResp:
                return FakeResp()

        monkeypatch.setattr(bills_module.httpx, "AsyncClient", FakeClient)
        with pytest.raises(ValueError, match="ai_unavailable"):
            await bills_module._call_minimax_api("x", [])

    async def test_raises_ai_unavailable_on_schema_drift(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(bills_module.settings, "minimax_api_key", "test-key", raising=False)

        class FakeResp:
            status_code = 200

            def json(self) -> dict:
                return {"choices": [{"message": {"content": '{"amount": -5, "payer_hint": "self"}'}}]}

        class FakeClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass
            async def __aenter__(self) -> "FakeClient":
                return self
            async def __aexit__(self, *a: Any) -> None:
                pass
            async def post(self, url: str, **kw: Any) -> FakeResp:
                return FakeResp()

        monkeypatch.setattr(bills_module.httpx, "AsyncClient", FakeClient)
        with pytest.raises(ValueError, match="ai_unavailable"):
            await bills_module._call_minimax_api("x", [])

    async def test_strips_code_fence(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(bills_module.settings, "minimax_api_key", "test-key", raising=False)

        class FakeResp:
            status_code = 200
            def json(self) -> dict:
                return {
                    "choices": [
                        {"message": {"content": '```json\n{"amount": 50, "payer_hint": "Bob", "participants_hint": ["Alice"], "description": "drinks"}\n```'}}
                    ]
                }

        class FakeClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass
            async def __aenter__(self) -> "FakeClient":
                return self
            async def __aexit__(self, *a: Any) -> None:
                pass
            async def post(self, url: str, **kw: Any) -> FakeResp:
                return FakeResp()

        monkeypatch.setattr(bills_module.httpx, "AsyncClient", FakeClient)
        out = await bills_module._call_minimax_api("x", [])
        assert out["amount"] == 50.0
        assert out["payer_hint"] == "Bob"


# ---------------------------------------------------------------------------
# T10: Session isolation
# ---------------------------------------------------------------------------


class TestSessionIsolationBills:
    def test_cannot_list_bills_of_other_session(self, client: TestClient) -> None:
        a, _ = _login_as("alice@bills.local")
        c_bob, bob_user = _login_as("bob@bills.local")
        sid_a, _ = _make_5_member_session()
        # Create a separate session owned by bob (alice is NOT a member).
        db = SessionLocal()
        try:
            from datetime import datetime, timedelta, timezone
            import secrets as _secrets
            _now = datetime.now(timezone.utc)
            sid_b = SessionModel(
                name="Bob Trip",
                owner_user_id=bob_user.id,
                invite_token=_secrets.token_urlsafe(32),
                invite_expires_at=_now + timedelta(days=30),
                invite_created_at=_now,
                session_code=_secrets.token_hex(4),
            )
            db.add(sid_b)
            db.flush()
            db.add(SessionMember(
                session_id=sid_b.id,
                user_id=bob_user.id,
                display_name="Bob",
                role=SessionRole.OWNER.value,
            ))
            db.commit()
            sid_b_id = sid_b.id
        finally:
            db.close()

        r = a.get(f"/sessions/{sid_b_id}/bills")
        assert r.status_code == 403

    def test_cannot_post_bill_to_other_session(self, client: TestClient) -> None:
        a, _ = _login_as("alice@bills.local")
        b, _ = _login_as("bob@bills.local")
        sid_a, mids_a = _make_5_member_session()
        sid_b_id = sid_a + 999  # non-existent

        # Need to be a member of the URL session to reach the validation.
        # Since sid_b_id doesn't exist, get_session_member raises 403 first.
        body = _bill_payload(
            payer_member_id=mids_a["alice@bills.local"],
            member_ids=[mids_a["alice@bills.local"]],
            amount=100.0,
        )
        r = a.post(f"/sessions/{sid_b_id}/bills", json=body)
        assert r.status_code == 403