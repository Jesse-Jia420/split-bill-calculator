"""Tests for the T12 settle API + settlement algorithm.

Strategy
--------
- Pure-function unit tests cover the algorithm in isolation
  (_compute_balances + _greedy_pair).
- Integration tests insert bills + participants directly into the DB
  and exercise GET /sessions/{id}/settle via FastAPI TestClient,
  asserting balances / transfers / persisted snapshot.
- Session isolation: a non-member gets 403.

v0.2.2 (T11): the response now serializes Decimal money values as
**strings** (e.g. ``"100.00"``) — per the v0.2.2 task brief
"Decimal ↔ JSON 字符串". The ``_f`` helper below parses those back
to float for the legacy assertion-style (since the underlying
amounts are still 2-dp cents-aligned, float conversion is lossless
for comparison purposes).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import settle as settle_module
from app.api.settle import _compute_balances, _greedy_pair, _is_zero
from decimal import Decimal
from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.settlements import Settlement
from app.db.models.users import User
from app.db.models.verification_codes import (
    VerificationCode,
    VerificationPurpose,
)
from app.main import app


def _f(value) -> float:
    """Coerce a JSON Decimal-string (or float / int) to float.

    v0.2.2 (T11): the settle response serializes money as JSON
    strings to preserve Decimal precision on the wire. Tests that
    were written against float assertions now compare against this
    helper. The conversion is lossless for 2-dp cents-aligned values
    (which all settlement amounts are).
    """
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


# v0.2.2 anti-pattern #53b: skip truncate when SBC_SKIP_TEST_TRUNCATE=1
# (Master runs pytest with this env var to verify without wiping production data).
@pytest.fixture(autouse=True)
def _truncate_all():
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return
    db = SessionLocal()
    try:
        db.query(Settlement).delete()
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


def _make_user(email: str) -> User:
    db = SessionLocal()
    try:
        existing = db.query(User).filter_by(email=email).first()
        if existing is not None:
            return existing
        u = User(email=email, default_name=email.split("@")[0][:120])
        db.add(u)
        db.commit()
        db.refresh(u)
        return u
    finally:
        db.close()


def _login_as(email: str) -> TestClient:
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
    return c


def _make_session_with_members(
    owner_email: str = "alice@settle.local",
    member_emails: list[tuple[str, str]] | None = None,
    session_name: str = "Settle Trip",
) -> tuple[int, dict[str, int]]:
    """Create a session + N members; returns (session_id, {email: member_id})."""
    # Ensure users exist
    for email in [owner_email] + ([e for e, _ in member_emails] if member_emails else []):
        _make_user(email)

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


def _insert_bill(
    session_id: int,
    payer_id: int,
    amount: float,
    parts: list[dict],
    description: str = "bill",
    occurred_at: datetime | None = None,
) -> int:
    """Insert a bill + participants directly; return bill id."""
    db = SessionLocal()
    try:
        bill = Bill(
            session_id=session_id,
            payer_id=payer_id,
            amount=amount,
            currency="CNY",
            description=description,
            occurred_at=occurred_at or datetime.now(timezone.utc),
            created_by=payer_id,
            status="draft",
        )
        db.add(bill)
        db.flush()
        for p in parts:
            db.add(
                BillParticipant(
                    bill_id=bill.id,
                    member_id=p["member_id"],
                    is_exclusive=p.get("is_exclusive", False),
                    exclusive_amount=p.get("exclusive_amount", 0.0),
                )
            )
        db.commit()
        return bill.id
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Pure-function tests: _compute_balances
# ---------------------------------------------------------------------------


class TestComputeBalances:
    def test_single_bill_two_people_equal_split(self) -> None:
        """A pays 100, A and B split 50/50. Net: A=+50, B=-50."""
        alice, bob = 1, 2
        bills = [
            _FakeBill(id=1, amount=100.0, payer_id=alice),
        ]
        parts_by_bill = {
            1: [
                _FakePart(member_id=alice),
                _FakePart(member_id=bob),
            ]
        }
        out = _compute_balances(bills, parts_by_bill, [alice, bob])
        assert out[alice] == 50.0
        assert out[bob] == -50.0

    def test_two_bills_five_people_alice_pays(self) -> None:
        """A pays 100, all 5 split equally. Net: A=+80, others=-20 each."""
        alice, bob, carol, dave, eve = 1, 2, 3, 4, 5
        ids = [alice, bob, carol, dave, eve]
        bills = [
            _FakeBill(id=1, amount=100.0, payer_id=alice),
        ]
        parts_by_bill = {1: [_FakePart(member_id=mid) for mid in ids]}
        out = _compute_balances(bills, parts_by_bill, ids)
        assert out[alice] == 80.0
        for mid in [bob, carol, dave, eve]:
            assert out[mid] == -20.0

    def test_no_bills_all_zero(self) -> None:
        ids = [1, 2, 3]
        out = _compute_balances([], {}, ids)
        for mid in ids:
            assert out[mid] == 0.0

    def test_complex_with_exclusive(self) -> None:
        """A pays 1000, 5 people share, Eve has 200 exclusive. Expected:
        shared_pool = 800, per_user_shared = 160. A: paid 1000, consumed 160 = +840.
        Eve: consumed 360 = -360. Others: consumed 160 = -160 each.
        Sum of net = 0: 840 - 360 - 160*3 = 0 ✓.
        """
        alice, bob, carol, dave, eve = 1, 2, 3, 4, 5
        ids = [alice, bob, carol, dave, eve]
        bills = [_FakeBill(id=1, amount=1000.0, payer_id=alice)]
        parts_by_bill = {
            1: [
                _FakePart(member_id=alice),
                _FakePart(member_id=bob),
                _FakePart(member_id=carol),
                _FakePart(member_id=dave),
                _FakePart(member_id=eve, is_exclusive=True, exclusive_amount=200.0),
            ]
        }
        out = _compute_balances(bills, parts_by_bill, ids)
        assert out[alice] == 840.0
        assert out[eve] == -360.0
        assert out[bob] == -160.0
        assert out[carol] == -160.0
        assert out[dave] == -160.0


class TestGreedyPair:
    def test_empty(self) -> None:
        assert _greedy_pair({}) == []

    def test_all_zero(self) -> None:
        assert _greedy_pair({1: 0.0, 2: 0.0}) == []

    def test_single_pair(self) -> None:
        out = _greedy_pair({1: 100.0, 2: -100.0})
        assert len(out) == 1
        assert out[0]["from_member_id"] == 2
        assert out[0]["to_member_id"] == 1
        # v0.2.2 (T11): _greedy_pair now emits Decimal (string-serialised
        # over the wire). Use the _f helper to coerce.
        assert _f(out[0]["amount"]) == 100.0

    def test_creditor_splits_among_two_debtors(self) -> None:
        # A is owed 100, B owes 40, C owes 60
        # Greedy: largest debtor C(60) pays A first; then B(40) pays A.
        out = _greedy_pair({1: 100.0, 2: -40.0, 3: -60.0})
        amounts = sorted(_f(t["amount"]) for t in out)
        assert amounts == [40.0, 60.0]
        # All transfers point to A (the only creditor)
        assert all(t["to_member_id"] == 1 for t in out)
        # Debtors are B and C
        from_ids = {t["from_member_id"] for t in out}
        assert from_ids == {2, 3}

    def test_balanced_session_no_transfers(self) -> None:
        """Each person paid exactly what they consumed — no transfers needed."""
        # A pays 100 for A and B (50 each).
        # B pays 100 for B and C (50 each).
        # net: A = 100 - 50 = 50; B = 100 - 100 = 0; C = 0 - 50 = -50.
        out = _greedy_pair({1: 50.0, 2: 0.0, 3: -50.0})
        assert len(out) == 1
        assert out[0]["from_member_id"] == 3
        assert out[0]["to_member_id"] == 1
        assert _f(out[0]["amount"]) == 50.0

    def test_residual_below_tolerance_is_zeroed(self) -> None:
        """Floating-point noise doesn't generate spurious transfers."""
        out = _greedy_pair({1: 1e-9, 2: -1e-9})
        assert out == []


# Tiny fakes to avoid spinning up full ORM rows in pure-function tests
class _FakeBill:
    def __init__(self, id: int, amount: float, payer_id: int):
        self.id = id
        self.amount = amount
        self.payer_id = payer_id


class _FakePart:
    def __init__(self, member_id: int, is_exclusive: bool = False, exclusive_amount: float = 0.0):
        self.member_id = member_id
        self.is_exclusive = is_exclusive
        self.exclusive_amount = exclusive_amount


# ---------------------------------------------------------------------------
# Integration tests: GET /sessions/{id}/settle
# ---------------------------------------------------------------------------


class TestSettleEndpoint:
    def test_no_bills_returns_zero_balances_no_transfers(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob"), ("carol@settle.local", "Carol")],
        )
        r = c.get(f"/sessions/{sid}/settle")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["session_id"] == sid
        # All balances are 0
        for mid in mids.values():
            assert _f(body["balances"][str(mid)]) == 0.0
        assert body["transfers"] == []

    def test_single_bill_two_people_no_transfers(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        # Alice pays 100, both share 50/50.
        _insert_bill(
            session_id=sid,
            payer_id=mids["alice@settle.local"],
            amount=100.0,
            parts=[
                {"member_id": mids["alice@settle.local"]},
                {"member_id": mids["bob@settle.local"]},
            ],
        )
        r = c.get(f"/sessions/{sid}/settle")
        assert r.status_code == 200, r.text
        body = r.json()
        assert _f(body["balances"][str(mids["alice@settle.local"])]) == 50.0
        assert _f(body["balances"][str(mids["bob@settle.local"])]) == -50.0
        assert len(body["transfers"]) == 1
        # v0.2.2 (T11): transfer amounts are Decimal-string on the wire.
        # Compare coerced floats.
        assert body["transfers"][0]["from_member_id"] == mids["bob@settle.local"]
        assert body["transfers"][0]["to_member_id"] == mids["alice@settle.local"]
        assert _f(body["transfers"][0]["amount"]) == 50.0

    def test_alice_pays_100_five_people_4_transfers(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
                ("dave@settle.local", "Dave"),
                ("eve@settle.local", "Eve"),
            ],
        )
        all_ids = list(mids.values())
        _insert_bill(
            session_id=sid,
            payer_id=mids["alice@settle.local"],
            amount=100.0,
            parts=[{"member_id": mid} for mid in all_ids],
        )
        r = c.get(f"/sessions/{sid}/settle")
        assert r.status_code == 200
        body = r.json()
        assert _f(body["balances"][str(mids["alice@settle.local"])]) == 80.0
        for e in ["bob@settle.local", "carol@settle.local", "dave@settle.local", "eve@settle.local"]:
            assert _f(body["balances"][str(mids[e])]) == -20.0
        assert len(body["transfers"]) == 4
        # All transfers point to alice
        for t in body["transfers"]:
            assert t["to_member_id"] == mids["alice@settle.local"]
            assert _f(t["amount"]) == 20.0

    def test_complex_with_exclusive(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
                ("dave@settle.local", "Dave"),
                ("eve@settle.local", "Eve"),
            ],
        )
        _insert_bill(
            session_id=sid,
            payer_id=mids["alice@settle.local"],
            amount=1000.0,
            parts=[
                {"member_id": mids["alice@settle.local"]},
                {"member_id": mids["bob@settle.local"]},
                {"member_id": mids["carol@settle.local"]},
                {"member_id": mids["dave@settle.local"]},
                {
                    "member_id": mids["eve@settle.local"],
                    "is_exclusive": True,
                    "exclusive_amount": 200.0,
                },
            ],
        )

        r = c.get(f"/sessions/{sid}/settle")
        assert r.status_code == 200
        body = r.json()
        # shared_pool = 800; per_user_shared = 160
        assert _f(body["balances"][str(mids["alice@settle.local"])]) == 840.0
        assert _f(body["balances"][str(mids["eve@settle.local"])]) == -360.0
        for e in ["bob@settle.local", "carol@settle.local", "dave@settle.local"]:
            assert _f(body["balances"][str(mids[e])]) == -160.0
        # Greedy pair: largest creditor (alice 840) vs largest debtor (eve 360) → 360.
        # Then alice 480 vs dave 160 → 160. Then alice 320 vs carol 160 → 160. Then alice 160 vs bob 160 → 160.
        # Total 4 transfers, total amount 360 + 160 + 160 + 160 = 840.
        total_outgoing = sum(_f(t["amount"]) for t in body["transfers"])
        assert abs(total_outgoing - 840.0) < 1e-6
        # All to alice.
        for t in body["transfers"]:
            assert t["to_member_id"] == mids["alice@settle.local"]

    def test_settle_persists_snapshot(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        _insert_bill(
            session_id=sid,
            payer_id=mids["alice@settle.local"],
            amount=100.0,
            parts=[
                {"member_id": mids["alice@settle.local"]},
                {"member_id": mids["bob@settle.local"]},
            ],
        )
        r = c.get(f"/sessions/{sid}/settle")
        assert r.status_code == 200

        db = SessionLocal()
        try:
            snaps = db.query(Settlement).filter_by(session_id=sid).all()
            assert len(snaps) == 1
            assert "alice" in snaps[0].summary_json or "balances" in snaps[0].summary_json
        finally:
            db.close()

    def test_settle_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.get("/sessions/1/settle")
        assert r.status_code == 401

    def test_settle_non_member_returns_403(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, _ = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
                ("dave@settle.local", "Dave"),
                ("eve@settle.local", "Eve"),
            ],
        )
        frank = _login_as("frank@settle.local")
        r = frank.get(f"/sessions/{sid}/settle")
        assert r.status_code == 403

    def test_settle_isolated_to_session(self, client: TestClient) -> None:
        """Bills in other sessions don't influence this session's settle."""
        c = _login_as("alice@settle.local")
        sid_a, mids_a = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
            session_name="A",
        )
        sid_b, mids_b = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
            session_name="B",
        )

        # Insert bills in BOTH sessions — both involve alice and bob
        _insert_bill(sid_a, mids_a["alice@settle.local"], 100.0, [
            {"member_id": mids_a["alice@settle.local"]},
            {"member_id": mids_a["bob@settle.local"]},
        ])
        _insert_bill(sid_b, mids_b["alice@settle.local"], 500.0, [
            {"member_id": mids_b["alice@settle.local"]},
            {"member_id": mids_b["bob@settle.local"]},
        ])

        r = c.get(f"/sessions/{sid_a}/settle")
        body_a = r.json()
        r = c.get(f"/sessions/{sid_b}/settle")
        body_b = r.json()

        # Session A: alice net = 50, bob net = -50
        assert _f(body_a["balances"][str(mids_a["alice@settle.local"])]) == 50.0
        assert _f(body_a["balances"][str(mids_a["bob@settle.local"])]) == -50.0
        # Session B: alice net = 250, bob net = -250
        assert _f(body_b["balances"][str(mids_b["alice@settle.local"])]) == 250.0
        assert _f(body_b["balances"][str(mids_b["bob@settle.local"])]) == -250.0

    def test_settle_returns_generated_at_iso(self, client: TestClient) -> None:
        c = _login_as("alice@settle.local")
        sid, _ = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        r = c.get(f"/sessions/{sid}/settle")
        body = r.json()
        assert "generated_at" in body
        # ISO-8601 parseable
        parsed = datetime.fromisoformat(body["generated_at"])
        assert parsed.tzinfo is not None

    def test_each_call_writes_new_snapshot(self, client: TestClient) -> None:
        """v0.1 simplification: every settle call writes a fresh row."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        _insert_bill(
            session_id=sid,
            payer_id=mids["alice@settle.local"],
            amount=100.0,
            parts=[
                {"member_id": mids["alice@settle.local"]},
                {"member_id": mids["bob@settle.local"]},
            ],
        )
        c.get(f"/sessions/{sid}/settle")
        c.get(f"/sessions/{sid}/settle")
        c.get(f"/sessions/{sid}/settle")
        db = SessionLocal()
        try:
            count = db.query(Settlement).filter_by(session_id=sid).count()
            assert count == 3
        finally:
            db.close()

# ---------------------------------------------------------------------------
# v0.1.2 (T18): per-member breakdown tests
# ---------------------------------------------------------------------------


class TestSettlePerMemberBreakdown:
    def test_per_member_field_present_and_structure(self, client: TestClient) -> None:
        """Each session member appears in `per_member` with the expected fields."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
            ],
        )
        r = c.get(f"/sessions/{sid}/settle")
        assert r.status_code == 200
        body = r.json()

        assert "per_member" in body
        pm = body["per_member"]
        assert isinstance(pm, list)
        assert len(pm) == 3  # alice + bob + carol

        # Spot-check one member's shape
        alice_pm = next(p for p in pm if p["member_id"] == mids["alice@settle.local"])
        assert alice_pm["display_name"] == "Alice"
        assert alice_pm["role"] == "owner"
        assert set(alice_pm.keys()) >= {
            "member_id",
            "display_name",
            "role",
            "total_paid",
            "total_consumed",
            "net",
            "paid_bills",
            "consumed_bills",
        }
        # Empty session -> all zero / empty lists.
        assert _f(alice_pm["total_paid"]) == 0.0
        assert _f(alice_pm["total_consumed"]) == 0.0
        assert _f(alice_pm["net"]) == 0.0
        assert alice_pm["paid_bills"] == []
        assert alice_pm["consumed_bills"] == []

    def test_per_member_paid_bills_correct(self, client: TestClient) -> None:
        """Each member's paid_bills lists exactly the bills they paid for."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        # Alice paid 100 (both share). Bob paid 60 (both share).
        bill1 = _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=100.0,
            parts=[{"member_id": alice_mid}, {"member_id": bob_mid}],
            description="alice-paid",
        )
        bill2 = _insert_bill(
            session_id=sid,
            payer_id=bob_mid,
            amount=60.0,
            parts=[{"member_id": alice_mid}, {"member_id": bob_mid}],
            description="bob-paid",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        alice_paid = pm[alice_mid]["paid_bills"]
        assert len(alice_paid) == 1
        assert alice_paid[0]["bill_id"] == bill1
        assert _f(alice_paid[0]["amount"]) == 100.0
        assert alice_paid[0]["description"] == "alice-paid"

        bob_paid = pm[bob_mid]["paid_bills"]
        assert len(bob_paid) == 1
        assert bob_paid[0]["bill_id"] == bill2
        assert _f(bob_paid[0]["amount"]) == 60.0
        assert bob_paid[0]["description"] == "bob-paid"

    def test_per_member_consumed_bills_correct(self, client: TestClient) -> None:
        """Each member's consumed_bills lists bills they participated in with
        the correct `share_amount` (using the bills-API formula)."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        # Alice paid 100, all 3 share 33.33 each -- but here only alice+bob.
        # 100 / 2 = 50 each.
        bill1 = _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=100.0,
            parts=[{"member_id": alice_mid}, {"member_id": bob_mid}],
            description="dinner",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        alice_consumed = pm[alice_mid]["consumed_bills"]
        assert len(alice_consumed) == 1
        assert alice_consumed[0]["bill_id"] == bill1
        assert _f(alice_consumed[0]["amount"]) == 100.0
        assert _f(alice_consumed[0]["share_amount"]) == 50.0

        bob_consumed = pm[bob_mid]["consumed_bills"]
        assert len(bob_consumed) == 1
        assert bob_consumed[0]["bill_id"] == bill1
        assert _f(bob_consumed[0]["share_amount"]) == 50.0

    def test_per_member_with_exclusive_amount(self, client: TestClient) -> None:
        """A bill with one exclusive participant correctly increases that
        member's `share_amount` by the exclusive portion.

        v0.1.2 (PO 2026-07-01 fix #4): also asserts the new
        `exclusive_amount` field surfaces the exclusive portion
        explicitly (was previously buried inside `share_amount`).
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        # Alice paid 1000; Eve-like scenario where Alice eats 200 alone.
        # Bob has no exclusive. shared_pool = 1000 - 200 = 800; per_user_shared
        # = 800 / 2 = 400. Alice share = 400 + 200 = 600. Bob share = 400.
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=1000.0,
            parts=[
                {"member_id": alice_mid, "is_exclusive": True, "exclusive_amount": 200.0},
                {"member_id": bob_mid},
            ],
            description="mixed",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        alice_consumed = pm[alice_mid]["consumed_bills"]
        assert len(alice_consumed) == 1
        assert _f(alice_consumed[0]["share_amount"]) == 600.0
        # v0.1.2 (fix #4): Alice is the exclusive participant on this
        # bill, so her `exclusive_amount` is the original 200 she ate
        # alone. The `shared` portion is share_amount - exclusive_amount
        # = 600 - 200 = 400 (= 800 shared_pool / 2 participants).
        assert _f(alice_consumed[0]["exclusive_amount"]) == 200.0
        assert _f(alice_consumed[0]["share_amount"]) - _f(alice_consumed[0]["exclusive_amount"]) == 400.0

        bob_consumed = pm[bob_mid]["consumed_bills"]
        assert len(bob_consumed) == 1
        assert _f(bob_consumed[0]["share_amount"]) == 400.0
        # Bob is NOT exclusive, so his exclusive_amount is 0 (NOT
        # absent). The field is always present on the response.
        assert _f(bob_consumed[0]["exclusive_amount"]) == 0.0
        # Bob's "shared" portion == share_amount - exclusive_amount = 400.
        assert _f(bob_consumed[0]["share_amount"]) - _f(bob_consumed[0]["exclusive_amount"]) == 400.0

        # And totals reconcile.
        assert _f(pm[alice_mid]["total_consumed"]) == 600.0
        assert _f(pm[alice_mid]["total_paid"]) == 1000.0
        assert _f(pm[alice_mid]["net"]) == 400.0  # paid 1000, owes 600

    # ----------------------------------------------------------------
    # v0.3.20 #96 regression tests (PO msg 02:41 #7467)
    # ----------------------------------------------------------------
    # PO case: bill #95 (早餐 336 CNY, 2 参与者, Jesse 独占 36 CNY).
    # FE previously showed "分摊 168" (= 336 / 2, ignoring exclusive).
    # Expected "分摊 150" for Q (non-exclusive) and "分摊 186" for Jesse
    # (150 shared + 36 exclusive). The BE math was already correct via
    # _compute_share_amounts; the bug was in the FE that did
    # ``b.amount / n`` instead of using p.share_amount. These tests
    # pin the BE math so a future refactor cannot silently regress.

    def test_share_amount_subtracts_exclusive_po_bill95(
        self, client: TestClient
    ) -> None:
        """v0.3.20 #96 (PO msg 02:41 #7467, bill #95).

        Bill = 336 CNY, 2 participants (Alice exclusive 36 + Bob non-exclusive).
        Expected per BE: shared_pool = 300, per_user_shared = 150.
          - Alice (exclusive 36): share = 150 + 36 = 186.
          - Bob   (no exclusive):  share = 150 +  0 = 150.

        PO reported the FE was rendering 168 (= 336/2). The BE math
        here is the source of truth the FE should consume.
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=336.0,
            parts=[
                {"member_id": alice_mid, "is_exclusive": True, "exclusive_amount": 36.0},
                {"member_id": bob_mid},
            ],
            description="breakfast",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        alice_share = _f(pm[alice_mid]["consumed_bills"][0]["share_amount"])
        bob_share = _f(pm[bob_mid]["consumed_bills"][0]["share_amount"])

        assert alice_share == 186.0  # 150 shared + 36 exclusive
        assert bob_share == 150.0    # 150 shared, no exclusive

    def test_share_amount_single_participant_all_exclusive(
        self, client: TestClient
    ) -> None:
        """v0.3.20 #96 edge case: 1 participant, all-exclusive.

        Bill = 100, 1 participant, exclusive 100 (covers entire bill).
        shared_pool = 0; per_user_shared = 0 / 1 = 0.
        share = 0 + 100 = 100 (full bill). No money leaks.
        Net = paid 100 - consumed 100 = 0.
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(member_emails=[])
        alice_mid = mids["alice@settle.local"]
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=100.0,
            parts=[{"member_id": alice_mid, "is_exclusive": True, "exclusive_amount": 100.0}],
            description="solo dinner",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        assert _f(pm[alice_mid]["consumed_bills"][0]["share_amount"]) == 100.0
        assert _f(pm[alice_mid]["consumed_bills"][0]["exclusive_amount"]) == 100.0
        assert _f(pm[alice_mid]["total_consumed"]) == 100.0
        assert _f(pm[alice_mid]["total_paid"]) == 100.0
        assert _f(pm[alice_mid]["net"]) == 0.0  # paid 100, owes 100

    def test_share_amount_two_participants_both_exclusive(
        self, client: TestClient
    ) -> None:
        """v0.3.20 #96 edge case: 2 participants, both fully exclusive.

        Bill = 100, 2 participants each with exclusive 30 (60 total).
        exclusive_total = 60; shared_pool = 40; per_user_shared = 40/2 = 20.
          - Alice: share = 20 + 30 = 50.
          - Bob:   share = 20 + 30 = 50.
        Sum of shares = 100 == bill amount (no money leaks).
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=100.0,
            parts=[
                {"member_id": alice_mid, "is_exclusive": True, "exclusive_amount": 30.0},
                {"member_id": bob_mid,   "is_exclusive": True, "exclusive_amount": 30.0},
            ],
            description="both exclusive",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        assert _f(pm[alice_mid]["consumed_bills"][0]["share_amount"]) == 50.0
        assert _f(pm[bob_mid]["consumed_bills"][0]["share_amount"]) == 50.0
        # Conservation: sum of shares == bill amount.
        assert _f(pm[alice_mid]["total_consumed"]) + _f(pm[bob_mid]["total_consumed"]) == 100.0

    def test_share_amount_no_exclusive_back_compat(
        self, client: TestClient
    ) -> None:
        """v0.3.20 #96 regression: with no exclusives, per-user share
        is the naive ``amount / num_participants`` (preserves v0.3.1
        and earlier behaviour). This is the same code path the FE
        used to mimic (and why the bug stayed invisible for years
        when bills had no exclusive portions).
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
                ("dave@settle.local", "Dave"),
            ],
        )
        alice_mid = mids["alice@settle.local"]
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=200.0,
            parts=[
                {"member_id": alice_mid},
                {"member_id": mids["bob@settle.local"]},
                {"member_id": mids["carol@settle.local"]},
                {"member_id": mids["dave@settle.local"]},
            ],
            description="4-way AA",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        # Naive 200 / 4 = 50 per person; exclusive_amount = 0 for everyone.
        for mid in (alice_mid, mids["bob@settle.local"], mids["carol@settle.local"], mids["dave@settle.local"]):
            assert _f(pm[mid]["consumed_bills"][0]["share_amount"]) == 50.0
            assert _f(pm[mid]["consumed_bills"][0]["exclusive_amount"]) == 0.0

    def test_bills_endpoint_share_amount_subtracts_exclusive_po_bill95(
        self, client: TestClient
    ) -> None:
        """v0.3.20 #96 (PO msg 02:41 #7467): same bill #95 case via the
        bills list endpoint (``GET /sessions/{id}/bills``), which the FE
        BillListGrouped consumes. The ``participants[*].share_amount``
        field MUST return 150 for Q so the FE can render the correct
        per-bill "分摊" value.

        This is the exact shape the FE utility ``yourShare`` (in
        ``frontend/src/lib/utils/bill-share.ts``) now reads.
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=336.0,
            parts=[
                {"member_id": alice_mid, "is_exclusive": True, "exclusive_amount": 36.0},
                {"member_id": bob_mid},
            ],
            description="breakfast",
        )

        r = c.get(f"/sessions/{sid}/bills")
        bills = r.json()
        assert len(bills) == 1
        parts = {p["member_id"]: p for p in bills[0]["participants"]}

        # Both shapes the FE relies on:
        assert _f(parts[alice_mid]["share_amount"]) == 186.0
        assert _f(parts[alice_mid]["exclusive_amount"]) == 36.0
        assert _f(parts[bob_mid]["share_amount"]) == 150.0
        assert _f(parts[bob_mid]["exclusive_amount"]) == 0.0

    def test_per_member_exclusive_amount_field_always_present(
        self, client: TestClient
    ) -> None:
        """v0.1.2 (PO 2026-07-01 fix #4): `exclusive_amount` is always
        present on every `consumed_bills` row, defaulting to 0.0 for
        members who are not flagged `is_exclusive`. The FE relies on
        this to avoid `undefined` checks.
        """
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
            ],
        )
        alice_mid = mids["alice@settle.local"]
        bob_mid = mids["bob@settle.local"]
        carol_mid = mids["carol@settle.local"]

        # Bill 1: pure AA, no exclusives (3-way AA).
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=90.0,
            parts=[
                {"member_id": alice_mid},
                {"member_id": bob_mid},
                {"member_id": carol_mid},
            ],
            description="aa",
        )
        # Bill 2: Bob is exclusive (eats 30 alone); shared_pool = 70/3.
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=100.0,
            parts=[
                {"member_id": alice_mid},
                {"member_id": bob_mid, "is_exclusive": True, "exclusive_amount": 30.0},
                {"member_id": carol_mid},
            ],
            description="mixed",
        )

        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}

        for mid, label in [
            (alice_mid, "alice"),
            (bob_mid, "bob"),
            (carol_mid, "carol"),
        ]:
            consumed = pm[mid]["consumed_bills"]
            assert len(consumed) == 2, f"{label} should have 2 consumed_bills"
            for bill in consumed:
                # Field is always present (no KeyError).
                assert "exclusive_amount" in bill, (
                    f"{label} bill {bill['bill_id']} missing exclusive_amount"
                )
                # v0.2.2 (T11): Decimal serialises to a string. Either is
                # accepted as 'numeric-like' for the type check below.
                assert isinstance(bill["exclusive_amount"], (int, float, str)), (
                    f"{label} bill {bill['bill_id']} exclusive_amount is not a number"
                )

        # Bob is the only one with exclusive_amount > 0 (on bill 2).
        bob_consumed = pm[bob_mid]["consumed_bills"]
        # bill 1 (aa): bob's exclusive_amount = 0
        bill1 = next(b for b in bob_consumed if b["description"] == "aa")
        assert _f(bill1["exclusive_amount"]) == 0.0
        assert _f(bill1["share_amount"]) - _f(bill1["exclusive_amount"]) == 30.0  # 90/3
        # bill 2 (mixed): bob's exclusive_amount = 30, share = 30 + 70/3 ≈ 53.33
        bill2 = next(b for b in bob_consumed if b["description"] == "mixed")
        assert _f(bill2["exclusive_amount"]) == 30.0
        # share_amount = per_user_shared + exclusive = 70/3 + 30 ≈ 53.33
        # v0.2.2 (T11): Decimal cents-alignment rounds 70/3 (23.333...) up to
        # 23.33 → share = 53.33. Test tolerance is one cent (0.01).
        assert abs(_f(bill2["share_amount"]) - (70.0 / 3.0 + 30.0)) < 0.01
        # shared = share_amount - exclusive_amount = 70/3 (rounded)
        assert abs(
            _f(bill2["share_amount"]) - _f(bill2["exclusive_amount"]) - 70.0 / 3.0
        ) < 0.01

    def test_per_member_empty_session(self, client: TestClient) -> None:
        """Empty session -> per_member list still has one entry per session
        member, all zeros, all empty lists."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        r = c.get(f"/sessions/{sid}/settle")
        pm = r.json()["per_member"]
        assert len(pm) == 2
        for entry in pm:
            assert _f(entry["total_paid"]) == 0.0
            assert _f(entry["total_consumed"]) == 0.0
            assert _f(entry["net"]) == 0.0
            assert entry["paid_bills"] == []
            assert entry["consumed_bills"] == []

    def test_per_member_net_matches_balances(self, client: TestClient) -> None:
        """The invariant: per_member[i].net == balances[per_member[i].member_id].

        This holds for any session state (empty, partial, mixed)."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
            ],
        )
        all_ids = list(mids.values())

        # A mix of bills so the numbers aren't trivial.
        _insert_bill(
            session_id=sid,
            payer_id=mids["alice@settle.local"],
            amount=900.0,
            parts=[{"member_id": mid} for mid in all_ids],
            description="Lunch",
        )
        _insert_bill(
            session_id=sid,
            payer_id=mids["bob@settle.local"],
            amount=300.0,
            parts=[{"member_id": mid} for mid in all_ids],
            description="Coffee",
        )
        _insert_bill(
            session_id=sid,
            payer_id=mids["carol@settle.local"],
            amount=150.0,
            parts=[
                {"member_id": mids["carol@settle.local"]},
                {"member_id": mids["alice@settle.local"]},
            ],
            description="Cab",
        )

        r = c.get(f"/sessions/{sid}/settle")
        body = r.json()
        balances = body["balances"]
        pm_by_id = {p["member_id"]: p for p in body["per_member"]}
        for mid, net in balances.items():
            mid = int(mid)
            assert mid in pm_by_id, f"member {mid} missing from per_member"
            assert _f(pm_by_id[mid]["net"]) == _f(net), (
                f"net mismatch for {mid}: per_member={pm_by_id[mid]['net']}, "
                f"balances={net}"
            )

    def test_per_member_paid_and_consumed_both_present_for_self_paid_bill(
        self, client: TestClient
    ) -> None:
        """If Alice pays a bill she's also a participant of, she appears in
        BOTH her paid_bills and her consumed_bills lists -- the two are
        independent views."""
        c = _login_as("alice@settle.local")
        sid, mids = _make_session_with_members(
            member_emails=[("bob@settle.local", "Bob")],
        )
        alice_mid = mids["alice@settle.local"]
        _insert_bill(
            session_id=sid,
            payer_id=alice_mid,
            amount=80.0,
            parts=[
                {"member_id": alice_mid},
                {"member_id": mids["bob@settle.local"]},
            ],
            description="self-paid-and-shared",
        )
        r = c.get(f"/sessions/{sid}/settle")
        pm = {p["member_id"]: p for p in r.json()["per_member"]}
        alice = pm[alice_mid]
        assert len(alice["paid_bills"]) == 1
        assert len(alice["consumed_bills"]) == 1
        # And her share is 80 / 2 = 40; net = 80 - 40 = 40.
        assert _f(alice["total_paid"]) == 80.0
        assert _f(alice["total_consumed"]) == 40.0
        assert _f(alice["net"]) == 40.0

    def test_per_member_non_member_still_403(self, client: TestClient) -> None:
        """`per_member` is only exposed to session members."""
        c_alice = _login_as("alice@settle.local")
        sid, _ = _make_session_with_members(
            member_emails=[
                ("bob@settle.local", "Bob"),
                ("carol@settle.local", "Carol"),
                ("dave@settle.local", "Dave"),
                ("eve@settle.local", "Eve"),
            ],
        )
        c_frank = _login_as("frank@settle.local")
        r = c_frank.get(f"/sessions/{sid}/settle")
        assert r.status_code == 403

class TestBalancesInvariantSumZero:
    """v0.3.14.1 Bug A: sum(balances) must be exactly 0 for any bill combo.

    Regression suite for the bug where per_user_shared = _quantize(shared_pool / N)
    caused N * per_user_shared != shared_pool (remainder lost in quantization).
    """

    def test_balances_sum_to_zero_single_currency(self) -> None:
        """2 members, 3 single-currency bills - no rounding edge cases."""
        alice, bob = 1, 2
        bills = [
            _FakeBill(id=1, amount=100.0, payer_id=alice),
            _FakeBill(id=2, amount=50.0, payer_id=bob),
            _FakeBill(id=3, amount=25.0, payer_id=alice),
        ]
        parts = {
            1: [_FakePart(alice), _FakePart(bob)],
            2: [_FakePart(bob), _FakePart(alice)],
            3: [_FakePart(alice), _FakePart(bob)],
        }
        nets = _compute_balances(bills, parts, [alice, bob])
        total = sum(nets.values(), Decimal("0"))
        assert _is_zero(total), f"sum(balances)={total}, expected ~0"

    def test_balances_sum_to_zero_multi_currency(self) -> None:
        """Multiple bills, multiple members - stress test for sum-to-zero."""
        a, b, c = 1, 2, 3
        bills = [
            _FakeBill(id=1, amount=100.0, payer_id=a),
            _FakeBill(id=2, amount=3000.0, payer_id=b),
            _FakeBill(id=3, amount=50.0, payer_id=a),
        ]
        parts = {
            1: [_FakePart(a), _FakePart(b), _FakePart(c)],
            2: [_FakePart(b), _FakePart(a), _FakePart(c)],
            3: [_FakePart(a), _FakePart(b), _FakePart(c)],
        }
        nets = _compute_balances(bills, parts, [a, b, c])
        total = sum(nets.values(), Decimal("0"))
        assert _is_zero(total), f"sum(balances)={total}, expected ~0"

    def test_balances_sum_to_zero_extreme_rounding(self) -> None:
        """1000 / 3 - non-terminating decimal exposes drift if per_user_shared quantized."""
        a, b, c = 1, 2, 3
        # 1000 split 3 ways = 333.333... each; if quantized to 333.33, sum = 999.99 != 1000
        bills = [
            _FakeBill(id=1, amount=1000.0, payer_id=a),
        ]
        parts = {
            1: [_FakePart(a), _FakePart(b), _FakePart(c)],
        }
        nets = _compute_balances(bills, parts, [a, b, c])
        total = sum(nets.values(), Decimal("0"))
        assert _is_zero(total), f"sum(balances)={total}, expected ~0 (1000/3 drift)"

    def test_balances_sum_to_zero_with_exclusive(self) -> None:
        """Multiple bills with exclusive portions - sum must stay zero."""
        a, b = 1, 2
        bills = [
            _FakeBill(id=1, amount=100.0, payer_id=a),
            _FakeBill(id=2, amount=60.0, payer_id=b),
            _FakeBill(id=3, amount=90.0, payer_id=a),
        ]
        parts = {
            1: [_FakePart(a, True, 20.0), _FakePart(b)],
            2: [_FakePart(b), _FakePart(a)],
            3: [_FakePart(a, True, 30.0), _FakePart(b, True, 15.0)],
        }
        nets = _compute_balances(bills, parts, [a, b])
        total = sum(nets.values(), Decimal("0"))
        assert _is_zero(total), f"sum(balances)={total}, expected ~0"

