"""End-to-end session + invite lifecycle tests.

Full happy-path:
  1. Alice creates a session (becomes owner)
  2. Alice generates an invite link
  3. Bob requests the invite token (GET /invites/{token})
  4. Bob accepts the invite (POST /invites/{token}/accept)
  5. Both Alice and Bob see 2 members in the session detail
  6. Alice (owner) revokes the invite
  7. After revocation, Bob gets 404 on GET /invites/{token}

We use direct DB insertion (bypassing email/SMTP) for user creation,
the same pattern established in test_sessions.py.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.session_invites import SessionInvite
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User
from app.db.models.verification_codes import VerificationCode
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate_all():
    """Reset all relevant tables between tests."""
    db = SessionLocal()
    try:
        db.query(SessionInvite).delete()
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


def _login_as(email: str) -> TestClient:
    """Insert user + auth_token row, return client with pre-set cookie."""
    db = SessionLocal()
    try:
        user = User(email=email, default_name=email.split("@")[0][:120])
        db.add(user)
        db.flush()

        raw = secrets.token_urlsafe(32)
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


# ---------------------------------------------------------------------------
# End-to-end session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    """The complete session journey from creation to revocation."""

    def test_session_lifecycle(self, client: TestClient) -> None:
        # 1. Alice creates a session.
        alice = _login_as("alice@flow.local")
        r = alice.post("/sessions", json={"name": "Bangkok 2026-07"})
        assert r.status_code == 201, r.text
        body = r.json()
        session_id = body["id"]
        assert body["name"] == "Bangkok 2026-07"
        assert body["role"] == SessionRole.OWNER.value
        assert body["member_count"] == 1

        # 2. Alice generates an invite link.
        r = alice.post(f"/sessions/{session_id}/invites")
        assert r.status_code == 201, r.text
        invite_body = r.json()
        token = invite_body["token"]
        assert isinstance(token, str) and len(token) >= 32
        assert invite_body["session_id"] == session_id

        # 3. Bob (unauthenticated) can preview the invite (public route).
        anon = TestClient(app)
        r = anon.get(f"/invites/{token}")
        assert r.status_code == 200, r.text
        preview = r.json()
        assert preview["session_id"] == session_id
        assert preview["session_name"] == "Bangkok 2026-07"
        assert preview["status"] == "active"

        # 4. Bob logs in (his own separate session cookie).
        bob = _login_as("bob@flow.local")

        # Bob is NOT a member yet — 403 on session detail.
        r = bob.get(f"/sessions/{session_id}")
        assert r.status_code == 403

        # 5. Bob accepts the invite.
        r = bob.post(f"/invites/{token}/accept", json={"display_name": "Bob"})
        assert r.status_code == 200, r.text
        join_body = r.json()
        assert join_body["session_id"] == session_id
        assert join_body["role"] == SessionRole.MEMBER.value
        assert join_body["display_name"] == "Bob"

        # 6. Bob is now a member — can fetch session detail.
        r = bob.get(f"/sessions/{session_id}")
        assert r.status_code == 200, r.text
        detail = r.json()
        assert detail["id"] == session_id
        emails = sorted(m["email"] for m in detail["members"])
        assert emails == ["alice@flow.local", "bob@flow.local"], emails

        # 7. Alice also sees 2 members.
        r = alice.get(f"/sessions/{session_id}")
        assert r.status_code == 200, r.text
        alice_detail = r.json()
        assert len(alice_detail["members"]) == 2

        # 8. Alice lists her sessions — the Bangkok trip is there.
        r = alice.get("/sessions")
        assert r.status_code == 200, r.text
        alice_sessions = {s["name"]: s for s in r.json()}
        assert "Bangkok 2026-07" in alice_sessions
        assert alice_sessions["Bangkok 2026-07"]["member_count"] == 2

        # 9. Alice (owner) revokes the invite.
        invite_id = invite_body["id"]
        r = alice.delete(f"/sessions/{session_id}/invites/{invite_id}")
        assert r.status_code == 204, r.text

        # 10. The invite is now gone (404 for everyone).
        r = anon.get(f"/invites/{token}")
        assert r.status_code == 404, r.text

        # 11. Bob's membership is still valid (revoke only affects the invite token).
        r = bob.get(f"/sessions/{session_id}")
        assert r.status_code == 200

    def test_non_member_cannot_create_invite(self, client: TestClient) -> None:
        """A user who is not a member of a session cannot generate an invite."""
        alice = _login_as("alice@flow.local")
        bob = _login_as("bob@flow.local")

        r = alice.post("/sessions", json={"name": "Alice Private"})
        session_id = r.json()["id"]

        r = bob.post(f"/sessions/{session_id}/invites")
        assert r.status_code == 403, r.text

    def test_owner_can_revoke_invite_but_member_cannot(
        self, client: TestClient
    ) -> None:
        """Only the session owner can revoke an invite."""
        alice = _login_as("alice@flow.local")
        bob = _login_as("bob@flow.local")

        r = alice.post("/sessions", json={"name": "Bangkok"})
        session_id = r.json()["id"]

        # Add Bob as a non-owner member.
        db = SessionLocal()
        try:
            bob_user = db.query(User).filter_by(email="bob@flow.local").one()
            db.add(
                SessionMember(
                    session_id=session_id,
                    user_id=bob_user.id,
                    display_name="Bob",
                    role=SessionRole.MEMBER.value,
                )
            )
            db.commit()
        finally:
            db.close()

        r = alice.post(f"/sessions/{session_id}/invites")
        invite_id = r.json()["id"]

        # Member (Bob) cannot revoke.
        r = bob.delete(f"/sessions/{session_id}/invites/{invite_id}")
        assert r.status_code == 403, r.text

        # Owner (Alice) can revoke.
        r = alice.delete(f"/sessions/{session_id}/invites/{invite_id}")
        assert r.status_code == 204, r.text

    def test_session_isolation_other_user_cannot_access(
        self, client: TestClient
    ) -> None:
        """User A who is not in session B cannot read or interact with it."""
        alice = _login_as("alice@flow.local")
        bob = _login_as("bob@flow.local")

        r = alice.post("/sessions", json={"name": "Alice Trip"})
        alice_session_id = r.json()["id"]

        # Bob cannot read Alice's session.
        r = bob.get(f"/sessions/{alice_session_id}")
        assert r.status_code == 403

        # Bob cannot create an invite for Alice's session.
        r = bob.post(f"/sessions/{alice_session_id}/invites")
        assert r.status_code == 403

        # Bob creates his own session — works fine.
        r = bob.post("/sessions", json={"name": "Bob Trip"})
        assert r.status_code == 201
