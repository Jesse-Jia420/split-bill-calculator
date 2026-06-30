"""Tests for the T12 settle API + settlement algorithm.

Strategy
--------
- Pure-function unit tests cover the algorithm in isolation
  (_compute_balances + _greedy_pair).
- Integration tests insert bills + participants directly into the DB
  and exercise GET /sessions/{id}/settle via FastAPI TestClient,
  asserting balances / transfers / persisted snapshot.
- Session isolation: a non-member gets 403.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import settle as settle_module
from app.api.settle import _compute_balances, _greedy_pair
from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.settlements import Settlement
from app.db.models.users import User
from app.db.models.verification_codes import (
    VerificationCode,
    VerificationPurpose,
)
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate_all():
    db = SessionLocal()
    try:
        db.query(Settlement).delete()
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
        assert out[0]["amount"] == 100.0

    def test_creditor_splits_among_two_debtors(self) -> None:
        # A is owed 100, B owes 40, C owes 60
        # Greedy: largest debtor C(60) pays A first; then B(40) pays A.
        out = _greedy_pair({1: 100.0, 2: -40.0, 3: -60.0})
        amounts = sorted(t["amount"] for t in out)
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
        assert out[0]["amount"] == 50.0

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
            assert body["balances"][str(mid)] == 0.0
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
        assert body["balances"][str(mids["alice@settle.local"])] == 50.0
        assert body["balances"][str(mids["bob@settle.local"])] == -50.0
        assert len(body["transfers"]) == 1
        assert body["transfers"][0] == {
            "from_member_id": mids["bob@settle.local"],
            "to_member_id": mids["alice@settle.local"],
            "amount": 50.0,
        }

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
        assert body["balances"][str(mids["alice@settle.local"])] == 80.0
        for e in ["bob@settle.local", "carol@settle.local", "dave@settle.local", "eve@settle.local"]:
            assert body["balances"][str(mids[e])] == -20.0
        assert len(body["transfers"]) == 4
        # All transfers point to alice
        for t in body["transfers"]:
            assert t["to_member_id"] == mids["alice@settle.local"]
            assert t["amount"] == 20.0

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
        assert body["balances"][str(mids["alice@settle.local"])] == 840.0
        assert body["balances"][str(mids["eve@settle.local"])] == -360.0
        for e in ["bob@settle.local", "carol@settle.local", "dave@settle.local"]:
            assert body["balances"][str(mids[e])] == -160.0
        # Greedy pair: largest creditor (alice 840) vs largest debtor (eve 360) → 360.
        # Then alice 480 vs dave 160 → 160. Then alice 320 vs carol 160 → 160. Then alice 160 vs bob 160 → 160.
        # Total 4 transfers, total amount 360 + 160 + 160 + 160 = 840.
        total_outgoing = sum(t["amount"] for t in body["transfers"])
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
        assert body_a["balances"][str(mids_a["alice@settle.local"])] == 50.0
        assert body_a["balances"][str(mids_a["bob@settle.local"])] == -50.0
        # Session B: alice net = 250, bob net = -250
        assert body_b["balances"][str(mids_b["alice@settle.local"])] == 250.0
        assert body_b["balances"][str(mids_b["bob@settle.local"])] == -250.0

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