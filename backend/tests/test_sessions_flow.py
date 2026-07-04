"""End-to-end session lifecycle — Sprint 1 T07+T08+T09 + v0.1.1 redesign.

v0.1.1 changes
--------------
- Invites are per-session fixed tokens minted on session create. The
  end-to-end flow here exercises:
    POST /sessions                                  -> mints token
    GET /sessions/{id}/invite                       -> any member reads
    GET /invites/{token}                            -> public preview
    POST /invites/{token}/accept                    -> join (idempotent)
    POST /sessions/{id}/invite/rotate               -> owner invalidates
- The old "mint second + revoke" + DELETE /sessions/{id}/invites/{iid}
  steps are replaced by rotate-invalidate-verify.
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
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate_all():

    # v0.2.2 anti-pattern #53b: skip truncate when SBC_SKIP_TEST_TRUNCATE=1
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return

def _truncate_all():
    """Reset all relevant tables between tests."""
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


# ---------------------------------------------------------------------------
# End-to-end session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    """The complete session journey from creation to rotation."""

    def test_session_lifecycle(self, client: TestClient) -> None:
        # 1. Alice creates a session. POST /sessions now auto-mints the
        #    fixed invite token (v0.1.1 -- there is no separate "mint"
        #    call anymore).
        alice = _login_as("alice@flow.local")
        r = alice.post("/sessions", json={"name": "Bangkok 2026-07"})
        assert r.status_code == 201, r.text
        body = r.json()
        session_id = body["id"]
        assert body["name"] == "Bangkok 2026-07"
        assert body["role"] == SessionRole.OWNER.value
        assert body["member_count"] == 1
        # Token must NOT leak through the summary response (kept tight).
        assert "invite_token" not in body
        assert "invite_url" not in body

        # 2. Alice reads the current invite token (any member can read).
        r = alice.get(f"/sessions/{session_id}/invite")
        assert r.status_code == 200, r.text
        invite_body = r.json()
        token = invite_body["token"]
        assert isinstance(token, str) and len(token) >= 32
        assert invite_body["status"] == "active"
        assert invite_body["url"] == f"/invites/{token}"

        # 3. Anonymous preview of the invite (public route).
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

        # 9. Alice (owner) rotates the invite token. The old token
        #    must immediately become a 404 (not 410) when probed.
        r = alice.post(f"/sessions/{session_id}/invite/rotate")
        assert r.status_code == 200, r.text
        rotated = r.json()
        new_token = rotated["token"]
        assert new_token != token, "rotation must change the token"

        r = anon.get(f"/invites/{token}")
        assert r.status_code == 404, r.text

        # 10. The NEW token works for the next would-be invitee.
        r = anon.get(f"/invites/{new_token}")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "active"

        # 11. Bob's existing membership is still valid (rotation does
        #     not affect existing members).
        r = bob.get(f"/sessions/{session_id}")
        assert r.status_code == 200
        bob_emails = sorted(m["email"] for m in r.json()["members"])
        assert "bob@flow.local" in bob_emails

        # 12. Bob can also re-accept his OLD token's URL if he revisits
        #     the same link from a different device -- the old token is
        #     404 in the public preview, BUT Bob is already a member so
        #     any future invite with a fresh token would just be
        #     idempotent. (PO i: "accepted still works".)

    def test_non_member_cannot_read_invite(self, client: TestClient) -> None:
        """v0.1.1: a non-member cannot read GET /sessions/{id}/invite (403)."""
        alice = _login_as("alice@flow.local")
        bob = _login_as("bob@flow.local")

        r = alice.post("/sessions", json={"name": "Alice Private"})
        session_id = r.json()["id"]

        r = bob.get(f"/sessions/{session_id}/invite")
        assert r.status_code == 403, r.text

    def test_non_member_cannot_rotate(self, client: TestClient) -> None:
        """v0.1.1: a non-member cannot rotate (403)."""
        alice = _login_as("alice@flow.local")
        bob = _login_as("bob@flow.local")

        r = alice.post("/sessions", json={"name": "Bangkok"})
        session_id = r.json()["id"]

        r = bob.post(f"/sessions/{session_id}/invite/rotate")
        assert r.status_code == 403, r.text

    def test_member_cannot_rotate_only_owner_can(self, client: TestClient) -> None:
        """v0.1.1: a non-owner member cannot rotate (403, "owner" msg)."""
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

        # Bob (member) cannot rotate.
        r = bob.post(f"/sessions/{session_id}/invite/rotate")
        assert r.status_code == 403, r.text
        assert "owner" in r.json()["detail"]["error"].lower()

        # Alice (owner) can rotate.
        r = alice.post(f"/sessions/{session_id}/invite/rotate")
        assert r.status_code == 200, r.text

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

        # Bob cannot read Alice's invite.
        r = bob.get(f"/sessions/{alice_session_id}/invite")
        assert r.status_code == 403

        # Bob cannot rotate Alice's invite.
        r = bob.post(f"/sessions/{alice_session_id}/invite/rotate")
        assert r.status_code == 403

        # Bob creates his own session — works fine.
        r = bob.post("/sessions", json={"name": "Bob Trip"})
        assert r.status_code == 201
