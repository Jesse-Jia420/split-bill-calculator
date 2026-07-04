"""T15 integration tests: session isolation end-to-end.

Strategy
--------
Where ``test_permission_matrix.py`` exercises the auth/role matrix
across endpoints, this file focuses on the **session isolation**
guarantee: data in session S1 must be invisible / inaccessible to
members of session S2 (and vice versa).

The PRD contract (PRD §3.5 + SPEC §5):
- ``get_session_member`` returns 403 for non-members (NOT 404) — this
  avoids enumeration: a probing client cannot tell "session doesn't
  exist" from "session exists but I'm not in it".
- All session-scoped endpoints go through this dependency, so the
  403-vs-401 decision is uniform.

Test scenarios
--------------
1. Alice creates S1, Bob joins. Carol creates S2, Dave joins.
2. Bob cannot read S2's detail / bills / settle → 403.
3. Carol cannot read S1's detail / bills / settle → 403.
4. Bob cannot mutate S2's bills → 403.
5. Bob cannot rotate S2's invite → 403.
6. Carol cannot rename Bob (cross-session).
7. After Bob is removed (v0.1.2 doesn't have remove, but we can test
   that rotation invalidates the OLD token visible to S1 members who
   had cached it).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate_all():

    # v0.2.2 anti-pattern #53b: skip truncate when SBC_SKIP_TEST_TRUNCATE=1
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return

def _truncate_all():
    db = SessionLocal()
    try:
        from app.db.models.settlements import Settlement

        db.query(Settlement).delete()
        db.query(BillParticipant).delete()
        db.query(Bill).delete()
        db.query(SessionMember).delete()
        db.query(SessionModel).delete()
        db.query(AuthToken).delete()
        db.query(User).delete()
        db.commit()
    finally:
        db.close()
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _ensure_user(email: str, default_name: str | None = None) -> None:
    db = SessionLocal()
    try:
        existing = db.query(User).filter_by(email=email).first()
        if existing is None:
            db.add(
                User(
                    email=email,
                    default_name=default_name or email.split("@")[0][:120],
                )
            )
            db.commit()
    finally:
        db.close()


def _login_as(email: str) -> TestClient:
    _ensure_user(email)
    raw = secrets.token_urlsafe(32)
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one()
        db.add(
            AuthToken(
                user_id=u.id,
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


def _create_session(owner_email: str, member_emails: list[str]) -> tuple[int, dict[str, int]]:
    """Create a session with given owner + N members."""
    _ensure_user(owner_email, "Owner")
    for m in member_emails:
        _ensure_user(m, m.split("@")[0].title())

    db = SessionLocal()
    try:
        owner = db.query(User).filter_by(email=owner_email).one()
        now = datetime.now(timezone.utc)
        sess = SessionModel(
            name=f"{owner_email}'s trip",
            owner_user_id=owner.id,
            invite_token=secrets.token_urlsafe(32),
            invite_expires_at=now + timedelta(days=30),
            invite_created_at=now,
        )
        db.add(sess)
        db.flush()
        owner_sm = SessionMember(
            session_id=sess.id,
            user_id=owner.id,
            display_name="Owner",
            role=SessionRole.OWNER.value,
        )
        db.add(owner_sm)
        db.flush()
        out: dict[str, int] = {owner_email: owner_sm.id}
        for email in member_emails:
            u = db.query(User).filter_by(email=email).one()
            sm = SessionMember(
                session_id=sess.id,
                user_id=u.id,
                display_name=email.split("@")[0].title(),
                role=SessionRole.MEMBER.value,
            )
            db.add(sm)
            db.flush()
            out[email] = sm.id
        db.commit()
        return sess.id, out
    finally:
        db.close()


def _add_bill(
    session_id: int,
    payer_member_id: int,
    participant_member_ids: list[int],
    amount: float = 100.0,
    description: str = "x",
) -> int:
    db = SessionLocal()
    try:
        bill = Bill(
            session_id=session_id,
            payer_id=payer_member_id,
            amount=amount,
            currency="CNY",
            description=description,
            occurred_at=datetime.now(timezone.utc),
            created_by=payer_member_id,
            status="draft",
        )
        db.add(bill)
        db.flush()
        for mid in participant_member_ids:
            db.add(
                BillParticipant(
                    bill_id=bill.id,
                    member_id=mid,
                    is_exclusive=False,
                    exclusive_amount=0.0,
                )
            )
        db.commit()
        return bill.id
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Cross-session reads (Bob cannot read S2)
# ---------------------------------------------------------------------------


class TestCrossSessionReads:
    """Members of S1 cannot read S2's data."""

    @pytest.fixture
    def two_sessions(self):
        """S1 = {alice, bob, carol}; S2 = {david, eve, frank}."""
        sid1, mids1 = _create_session(
            owner_email="alice@iso.local",
            member_emails=["bob@iso.local", "carol@iso.local"],
        )
        sid2, mids2 = _create_session(
            owner_email="david@iso.local",
            member_emails=["eve@iso.local", "frank@iso.local"],
        )
        # Add bills to both so lists are non-empty.
        _add_bill(
            sid1,
            mids1["alice@iso.local"],
            list(mids1.values()),
            amount=100.0,
            description="S1 dinner",
        )
        _add_bill(
            sid2,
            mids2["david@iso.local"],
            list(mids2.values()),
            amount=500.0,
            description="S2 hotel",
        )
        return sid1, mids1, sid2, mids2

    def test_bob_cannot_get_s2_detail(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.get(f"/sessions/{sid2}")
        # Per SPEC §5: 403 for non-members (deliberately indistinct from 404).
        assert r.status_code == 403

    def test_bob_cannot_list_s2_bills(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.get(f"/sessions/{sid2}/bills")
        assert r.status_code == 403

    def test_bob_cannot_settle_s2(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.get(f"/sessions/{sid2}/settle")
        assert r.status_code == 403

    def test_bob_cannot_see_s2_invite(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.get(f"/sessions/{sid2}/invite")
        assert r.status_code == 403

    def test_bob_cannot_parse_against_s2(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_bob = _login_as("bob@iso.local")
        from app.api import bills as bills_module

        async def fake_call(text: str, member_names: list[str]) -> dict:
            return {
                "amount": 1.0,
                "payer_hint": "self",
                "participants_hint": ["all"],
                "description": "",
            }

        mp = pytest.MonkeyPatch()
        mp.setattr(bills_module, "_call_minimax_api", fake_call)
        try:
            r = c_bob.post(f"/sessions/{sid2}/bills/parse", json={"text": "x"})
        finally:
            mp.undo()
        assert r.status_code == 403

    def test_david_cannot_get_s1_detail(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_david = _login_as("david@iso.local")
        r = c_david.get(f"/sessions/{sid1}")
        assert r.status_code == 403

    def test_eve_cannot_list_s1_bills(self, client: TestClient, two_sessions) -> None:
        sid1, _mids1, sid2, _mids2 = two_sessions
        c_eve = _login_as("eve@iso.local")
        r = c_eve.get(f"/sessions/{sid1}/bills")
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Cross-session writes (Bob cannot mutate S2)
# ---------------------------------------------------------------------------


class TestCrossSessionWrites:
    """Members of S1 cannot POST/PATCH/DELETE in S2."""

    @pytest.fixture
    def two_sessions(self):
        sid1, mids1 = _create_session(
            owner_email="alice@iso.local",
            member_emails=["bob@iso.local"],
        )
        sid2, mids2 = _create_session(
            owner_email="david@iso.local",
            member_emails=["eve@iso.local"],
        )
        # A bill in S2 (David's, so Bob can't touch it).
        s2_bid = _add_bill(
            sid2,
            mids2["david@iso.local"],
            list(mids2.values()),
            amount=300.0,
            description="S2 dinner",
        )
        return sid1, mids1, sid2, mids2, s2_bid

    def test_bob_cannot_post_bill_to_s2(
        self, client: TestClient, two_sessions
    ) -> None:
        sid1, mids1, sid2, mids2, _ = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.post(
            f"/sessions/{sid2}/bills",
            json={
                "amount": 999.0,
                "payer_member_id": mids2["david@iso.local"],
                "occurred_at": "2026-06-30T10:00:00Z",
                "participants": [{"member_id": mids2["david@iso.local"]}],
            },
        )
        assert r.status_code == 403

    def test_bob_cannot_patch_bill_in_s2(
        self, client: TestClient, two_sessions
    ) -> None:
        sid1, mids1, sid2, mids2, s2_bid = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.patch(f"/sessions/{sid2}/bills/{s2_bid}", json={"amount": 1.0})
        assert r.status_code == 403

    def test_bob_cannot_delete_bill_in_s2(
        self, client: TestClient, two_sessions
    ) -> None:
        sid1, mids1, sid2, mids2, s2_bid = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.delete(f"/sessions/{sid2}/bills/{s2_bid}")
        assert r.status_code == 403

    def test_bob_cannot_rotate_s2_invite(
        self, client: TestClient, two_sessions
    ) -> None:
        sid1, _mids1, sid2, _mids2, _ = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.post(f"/sessions/{sid2}/invite/rotate")
        assert r.status_code == 403

    def test_bob_cannot_rename_s2_member(
        self, client: TestClient, two_sessions
    ) -> None:
        sid1, _mids1, sid2, mids2, _ = two_sessions
        c_bob = _login_as("bob@iso.local")
        r = c_bob.patch(
            f"/sessions/{sid2}/members/{mids2['eve@iso.local']}",
            json={"display_name": "Hacked"},
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Cross-session self-only (Bob can't rename himself via S2's URL)
# ---------------------------------------------------------------------------


class TestCrossSessionSelf:
    """A member's self-row lives only in their own session — calling
    PATCH /sessions/{other_session}/members/{my_member_id_in_s1}
    should be 403 (not a member of other_session), even if the member_id
    matches Bob's S1 member_id (which doesn't exist in S2 anyway)."""

    def test_bob_self_id_in_s2_returns_403(self, client: TestClient) -> None:
        sid1, mids1 = _create_session(
            owner_email="alice@iso.local",
            member_emails=["bob@iso.local"],
        )
        sid2, _mids2 = _create_session(
            owner_email="david@iso.local",
            member_emails=[],
        )
        c_bob = _login_as("bob@iso.local")
        # Use Bob's S1 member_id (which is meaningless in S2's scope).
        r = c_bob.patch(
            f"/sessions/{sid2}/members/{mids1['bob@iso.local']}",
            json={"display_name": "NewName"},
        )
        # Bob is not a member of S2 → 403.
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Cross-session data leak checks (S1 bills don't appear in S2 reads)
# ---------------------------------------------------------------------------


class TestNoDataLeak:
    """Confirm that bills created in S1 don't leak into S2's reads
    (positive case: a member of S2 only sees S2 bills in their
    own session).
    """

    def test_s2_member_sees_only_s2_bills(self, client: TestClient) -> None:
        sid1, mids1 = _create_session(
            owner_email="alice@iso.local",
            member_emails=["bob@iso.local"],
        )
        sid2, mids2 = _create_session(
            owner_email="david@iso.local",
            member_emails=["eve@iso.local"],
        )
        # Add bills in both sessions.
        for _ in range(3):
            _add_bill(sid1, mids1["alice@iso.local"], list(mids1.values()))
            _add_bill(sid2, mids2["david@iso.local"], list(mids2.values()))

        c_david = _login_as("david@iso.local")
        r = c_david.get(f"/sessions/{sid2}/bills")
        assert r.status_code == 200
        bills = r.json()
        assert len(bills) == 3
        # Every bill must be in S2, not S1.
        for b in bills:
            assert b["session_id"] == sid2

    def test_s1_settle_does_not_include_s2_bills(
        self, client: TestClient
    ) -> None:
        sid1, mids1 = _create_session(
            owner_email="alice@iso.local",
            member_emails=["bob@iso.local"],
        )
        sid2, mids2 = _create_session(
            owner_email="david@iso.local",
            member_emails=["eve@iso.local"],
        )
        # 1000 in S1, 10000 in S2 — settle of S1 should NOT include the 10k.
        _add_bill(sid1, mids1["alice@iso.local"], list(mids1.values()), 100.0)
        _add_bill(sid2, mids2["david@iso.local"], list(mids2.values()), 10000.0)

        c_alice = _login_as("alice@iso.local")
        r = c_alice.get(f"/sessions/{sid1}/settle")
        assert r.status_code == 200
        body = r.json()
        # S1 has 1 bill, 2 members → each net ~50 / -50.
        # v0.2.2 (T11): balances come back as Decimal-as-string. Parse them.
        from decimal import Decimal as _D
        total_abs = sum(abs(float(str(v))) for v in body["balances"].values())
        assert abs(total_abs - 100.0) < 1.0, (
            f"S1 settle total balances {total_abs} suggest S2 bill leaked in"
        )


# ---------------------------------------------------------------------------
# 403 vs 404 distinction (PRD §3.5 enumeration-prevention)
# ---------------------------------------------------------------------------


class TestNoEnumerationLeak:
    """A probing client must not be able to tell whether a session id
    exists or not — both cases (not exists / not a member) return 403.

    This guards against: an attacker iterating session ids to discover
    which exist.
    """

    def test_nonexistent_session_id_returns_403_not_404(
        self, client: TestClient
    ) -> None:
        """A logged-in user probing a nonexistent session_id sees 403,
        not 404. Per SPEC §5: 'We never leak whether the session
        exists vs. whether the caller is not a member: both return 403.'
        """
        c = _login_as("alice@iso.local")
        r = c.get("/sessions/99999")
        assert r.status_code == 403  # NOT 404

    def test_real_session_id_for_non_member_returns_403(
        self, client: TestClient
    ) -> None:
        """Same code path: real session, but caller not in it → 403."""
        sid, _ = _create_session(
            owner_email="alice@iso.local",
            member_emails=[],
        )
        c = _login_as("outsider@iso.local")
        r = c.get(f"/sessions/{sid}")
        assert r.status_code == 403

    def test_status_codes_match_for_existing_vs_nonexistent(
        self, client: TestClient
    ) -> None:
        """Pin the contract: 403 in both cases, identical status."""
        sid, _ = _create_session(
            owner_email="alice@iso.local",
            member_emails=[],
        )
        c = _login_as("outsider@iso.local")
        r1 = c.get(f"/sessions/{sid}")  # exists, not a member
        r2 = c.get("/sessions/99999")  # doesn't exist
        assert r1.status_code == r2.status_code == 403


# ---------------------------------------------------------------------------
# /sessions list returns only sessions the caller belongs to
# ---------------------------------------------------------------------------


class TestListSessionsScopedToMembership:
    """GET /sessions returns ONLY sessions the caller is a member of."""

    def test_alice_sees_only_her_sessions(self, client: TestClient) -> None:
        # Alice in S1
        c_alice = _login_as("alice@iso.local")
        r = c_alice.post("/sessions", json={"name": "S1"})
        assert r.status_code == 201
        sid_alice = r.json()["id"]

        # Bob creates S2 (Alice not in it)
        c_bob = _login_as("bob@iso.local")
        r = c_bob.post("/sessions", json={"name": "S2"})
        assert r.status_code == 201
        sid_bob = r.json()["id"]

        # Alice lists → only S1.
        r = c_alice.get("/sessions")
        assert r.status_code == 200
        ids = {s["id"] for s in r.json()}
        assert sid_alice in ids
        assert sid_bob not in ids

    def test_user_with_no_sessions_sees_empty_list(
        self, client: TestClient
    ) -> None:
        c = _login_as("lone@iso.local")
        r = c.get("/sessions")
        assert r.status_code == 200
        assert r.json() == []


# ---------------------------------------------------------------------------
# Invite rotate invalidates old token
# ---------------------------------------------------------------------------


class TestInviteRotationIsolation:
    """Rotating the invite token invalidates the old token immediately,
    so anyone holding the old URL (e.g. an ex-member who copied the
    link) can no longer join.
    """

    def test_old_token_returns_404_after_rotation(
        self, client: TestClient
    ) -> None:
        sid, _ = _create_session(
            owner_email="alice@iso.local",
            member_emails=[],
        )
        db = SessionLocal()
        try:
            sess = db.query(SessionModel).filter_by(id=sid).one()
            old_token = sess.invite_token
        finally:
            db.close()

        # Owner rotates.
        c_owner = _login_as("alice@iso.local")
        r = c_owner.post(f"/sessions/{sid}/invite/rotate")
        assert r.status_code == 200
        new_token = r.json()["token"]

        # Old token now 404.
        r = client.get(f"/invites/{old_token}")
        assert r.status_code == 404

        # New token still 200.
        r = client.get(f"/invites/{new_token}")
        assert r.status_code == 200

    def test_old_token_accept_returns_404_after_rotation(
        self, client: TestClient
    ) -> None:
        sid, _ = _create_session(
            owner_email="alice@iso.local",
            member_emails=[],
        )
        db = SessionLocal()
        try:
            sess = db.query(SessionModel).filter_by(id=sid).one()
            old_token = sess.invite_token
        finally:
            db.close()

        c_owner = _login_as("alice@iso.local")
        c_owner.post(f"/sessions/{sid}/invite/rotate")

        # Try to accept the old token as a new user.
        c_joiner = _login_as("joiner@iso.local")
        r = c_joiner.post(
            f"/invites/{old_token}/accept",
            json={"display_name": "Late"},
        )
        assert r.status_code == 404