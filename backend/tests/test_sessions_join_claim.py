"""§3.11.11 join-claim 边界修复 — pytest unit tests (SPEC §3.11.11.E).

Three cases, covering the three PRD §3.11.11.5 decisions:

- beta (anon-to-anon): anon claims an anon-claimed slot → 200 + secret rotation
- gamma (anon-to-loggedin): anon claims a logged-in bound slot → 403 requires_login
- regression (anon-to-unclaimed): anon first-claims an empty slot → 200 + secret set

These exercise the rewritten anon claim branch in
``backend/app/api/sessions.py::join_claim_session`` (around line 1213+).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User
from app.db.models.verification_codes import VerificationCode
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures (mirror test_sessions.py conventions)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate_all():
    # v0.2.2 anti-pattern #53b: skip truncate when SBC_SKIP_TEST_TRUNCATE=1
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return
    db = SessionLocal()
    try:
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


@pytest.fixture
def mock_email_service():
    """Patch EmailService so /auth/send-code does not talk to a real SMTP."""
    with patch("app.api.auth.EmailService") as mock_cls:
        instance = mock_cls.return_value

        async def _noop(*_args, **_kwargs):
            return None

        instance.send_verification_code.side_effect = _noop
        yield mock_cls


def _make_user(email: str, default_name: str | None = None) -> User:
    db = SessionLocal()
    try:
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


def _login_as(email: str) -> tuple[TestClient, str]:
    user = _make_user(email)
    raw = secrets.token_urlsafe(32)
    db = SessionLocal()
    try:
        db.add(
            AuthToken(
                user_id=user.id,
                token_hash=hash_token(raw),
                expires_at=datetime.now(timezone.utc)
                + timedelta(days=30),
            )
        )
        db.commit()
    finally:
        db.close()
    c = TestClient(app)
    c.cookies.set(COOKIE_NAME, raw)
    return c, raw


def _make_anon_session(name: str = "hh") -> int:
    """Create a session with no owner (PRD §3.10 anonymous creator)."""
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        s = SessionModel(
            name=name,
            owner_user_id=None,
            owner_email=None,
            invite_token=secrets.token_urlsafe(32),
            invite_expires_at=now + timedelta(days=30),
            invite_created_at=now,
            currencies=["CNY"],
            primary_currency="CNY",
            session_code=secrets.token_hex(4),
            last_active_at=now,
        )
        db.add(s)
        db.commit()
        db.refresh(s)
        return s.id
    finally:
        db.close()


def _add_slot(
    session_id: int,
    display_name: str,
    *,
    user_id: int | None = None,
    nickname_secret: str | None = None,
    is_anon: bool = False,
    claimed: bool = False,
) -> int:
    """Insert a SessionMember slot directly. Returns its id.

    - ``user_id`` set → logged-in bound slot (decision gamma target).
    - ``nickname_secret`` set → anon-claimed slot (decision beta target).
    - both NULL → unclaimed slot (regression target).
    """
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        sm = SessionMember(
            session_id=session_id,
            user_id=user_id,
            display_name=display_name,
            role=SessionRole.MEMBER.value,
            is_anon=is_anon,
            nickname_secret=nickname_secret,
            claimed_at=now if (claimed or nickname_secret or user_id) else None,
        )
        db.add(sm)
        db.commit()
        db.refresh(sm)
        return sm.id
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Decision beta — anon claims an anon-claimed slot (rotation accepted)
# ---------------------------------------------------------------------------


class TestAnonClaimAnonSlot:
    """§3.11.11 decision beta: anon-to-anon → ACCEPT + rotate secret."""

    def test_anon_claim_anon_slot_overwrites_secret(
        self, client: TestClient, mock_email_service
    ) -> None:
        session_id = _make_anon_session("hh")
        old_secret = secrets.token_hex(32)
        j_slot = _add_slot(
            session_id, "j",
            user_id=None,
            nickname_secret=old_secret,
            is_anon=True,
            claimed=True,
        )

        anon = TestClient(app)
        r = anon.post(
            f"/sessions/{session_id}/join-claim",
            json={"action": "claim", "session_member_id": j_slot},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["session_member_id"] == j_slot
        assert body["is_anon"] is True
        new_secret = body["nickname_secret"]
        assert isinstance(new_secret, str) and len(new_secret) == 64
        # beta rotation: new secret MUST differ from the old one
        assert new_secret != old_secret

        # DB confirm: secret is the new one, claimed_at updated, user_id NULL
        db = SessionLocal()
        try:
            sm = db.query(SessionMember).filter_by(id=j_slot).first()
            assert sm is not None
            assert sm.nickname_secret == new_secret
            assert sm.is_anon is True
            assert sm.user_id is None
            assert sm.claimed_at is not None
        finally:
            db.close()

    def test_anon_claim_anon_slot_returns_member_id(
        self, client: TestClient, mock_email_service
    ) -> None:
        """Smoke: response includes the slot's display_name."""
        session_id = _make_anon_session("hh")
        k_slot = _add_slot(
            session_id, "k",
            user_id=None,
            nickname_secret=secrets.token_hex(32),
            is_anon=True,
            claimed=True,
        )
        anon = TestClient(app)
        r = anon.post(
            f"/sessions/{session_id}/join-claim",
            json={"action": "claim", "session_member_id": k_slot},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["display_name"] == "k"
        assert body["role"] == SessionRole.MEMBER.value


# ---------------------------------------------------------------------------
# Decision gamma — anon claims a logged-in bound slot → 403 requires_login
# ---------------------------------------------------------------------------


class TestAnonClaimLoggedInSlot:
    """§3.11.11 decision gamma: anon-to-loggedin → REJECT + requires_login."""

    def test_anon_claim_loggedin_slot_returns_403_requires_login(
        self, client: TestClient, mock_email_service
    ) -> None:
        # Login as jesse (logged-in bound slot owner).
        jesse_client, _ = _login_as("jesse@gamma.local")
        # _login_as already created the User row; look it up.
        db = SessionLocal()
        try:
            jesse = db.query(User).filter_by(email="jesse@gamma.local").first()
            assert jesse is not None
            jesse_id = jesse.id
        finally:
            db.close()
        session_id = _make_anon_session("hh")
        jesse_slot = _add_slot(
            session_id, "jesse",
            user_id=jesse_id,
            nickname_secret=None,
            is_anon=False,
            claimed=True,
        )

        anon = TestClient(app)
        r = anon.post(
            f"/sessions/{session_id}/join-claim",
            json={"action": "claim", "session_member_id": jesse_slot},
        )
        assert r.status_code == 403, r.text
        detail = r.json()["detail"]
        assert detail["error"] == "requires_login"
        assert "slot is owned by a logged-in user" in detail["reason"]
        assert detail["slot_owner_user_id"] == jesse_id

        # DB confirm: the slot's user_id was NOT cleared (impersonation
        # blocked — no partial writes).
        db = SessionLocal()
        try:
            sm = db.query(SessionMember).filter_by(id=jesse_slot).first()
            assert sm is not None
            assert sm.user_id == jesse_id
            assert sm.is_anon is False
        finally:
            db.close()


# ---------------------------------------------------------------------------
# Regression — anon first-claim of an unclaimed slot still works
# ---------------------------------------------------------------------------


class TestAnonClaimUnclaimedSlot:
    """§3.11.11 regression: anon-to-unclaimed first claim still works."""

    def test_anon_claim_unclaimed_slot_first_time(
        self, client: TestClient, mock_email_service
    ) -> None:
        session_id = _make_anon_session("hh")
        l_slot = _add_slot(
            session_id, "l",
            user_id=None,
            nickname_secret=None,  # unclaimed
            is_anon=False,
            claimed=False,
        )

        anon = TestClient(app)
        r = anon.post(
            f"/sessions/{session_id}/join-claim",
            json={"action": "claim", "session_member_id": l_slot},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["session_member_id"] == l_slot
        assert body["is_anon"] is True
        new_secret = body["nickname_secret"]
        assert isinstance(new_secret, str) and len(new_secret) == 64

        # DB confirm: slot is now anon-claimed
        db = SessionLocal()
        try:
            sm = db.query(SessionMember).filter_by(id=l_slot).first()
            assert sm is not None
            assert sm.nickname_secret == new_secret
            assert sm.is_anon is True
            assert sm.user_id is None
            assert sm.claimed_at is not None
        finally:
            db.close()
