"""Tests for the T07+T08 sessions API + v0.1.1 invite redesign.

Strategy
--------
- Each test starts from a clean DB (truncate all relevant tables in
  an autouse fixture).
- We mint "logged in" users by directly inserting a User + AuthToken
  + raw cookie value (mirrors what /auth/verify-code does, but
  without going through the email path).
- The same pattern tests the public session isolation: create user A
  and user B, log them in separately, and verify each only sees their
  own session(s) / 403s on the other's.

v0.1.1 invite changes
---------------------
- The old TestCreateInvite / TestDeleteInvite classes are GONE: there
  is no POST /sessions/{id}/invites or DELETE /sessions/{id}/invites/{iid}
  endpoint anymore. Invites are per-session fixed tokens, minted on
  session create and rotatable via POST /sessions/{id}/invite/rotate.
- TestGetSessionInvite covers GET /sessions/{id}/invite (member reads).
- TestRotateSessionInvite covers POST /sessions/{id}/invite/rotate
  (owner only).
- TestGetInvitePublic now seeds a session row (the only place that
  carries an invite_token) instead of a SessionInvite row.
- TestAcceptInvite seeds a session row too; idempotency check stays.
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
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
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
    """Patch EmailService so /auth/send-code does not talk to a real SMTP."""
    with patch("app.api.auth.EmailService") as mock_cls:
        instance: Any = mock_cls.return_value

        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        instance.send_verification_code.side_effect = _noop
        yield mock_cls


def _make_user(email: str, default_name: str | None = None) -> User:
    """Insert a User row directly (bypassing /auth/verify-code)."""
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
    """Insert user + auth_token row, return (client, raw_token).

    The TestClient gets the cookie pre-set so any subsequent request
    appears logged in. We return the raw token so tests can re-use it
    across multiple clients (e.g. for isolation tests).
    """
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


def _login_two(email_a: str, email_b: str) -> tuple[TestClient, str, TestClient, str]:
    """Return two clients (A, B) each with their own login cookie."""
    client_a, raw_a = _login_as(email_a)
    client_b, raw_b = _login_as(email_b)
    return client_a, raw_a, client_b, raw_b


# ---------------------------------------------------------------------------
# TestCreateSession
# ---------------------------------------------------------------------------


class TestCreateSession:
    def test_create_returns_201_with_owner_payload(self, client: TestClient) -> None:
        client_a, _ = _login_as("alice@t07.local")
        r = client_a.post("/sessions", json={"name": "Bangkok 2026-07"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["name"] == "Bangkok 2026-07"
        assert body["role"] == SessionRole.OWNER.value
        assert body["member_count"] == 1
        assert isinstance(body["id"], int)
        assert isinstance(body["owner_user_id"], int)
        assert "created_at" in body

    def test_missing_name_returns_422(self, client: TestClient) -> None:
        client_a, _ = _login_as("alice@t07.local")
        r = client_a.post("/sessions", json={})
        assert r.status_code == 422

    def test_blank_name_returns_400(self, client: TestClient) -> None:
        client_a, _ = _login_as("alice@t07.local")
        r = client_a.post("/sessions", json={"name": "   "})
        assert r.status_code == 400, r.text
        assert r.json()["detail"]["error"] == "name must not be blank"

    def test_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.post("/sessions", json={"name": "x"})
        assert r.status_code == 401, r.text

    def test_owner_is_also_member_row(self, client: TestClient) -> None:
        client_a, _ = _login_as("alice@t07.local")
        r = client_a.post("/sessions", json={"name": "Bangkok 2026-07"})
        session_id = r.json()["id"]

        db = SessionLocal()
        try:
            members = (
                db.query(SessionMember).filter_by(session_id=session_id).all()
            )
            assert len(members) == 1
            assert members[0].role == SessionRole.OWNER.value
        finally:
            db.close()

    def test_create_session_mints_invite_token_in_db(self, client: TestClient) -> None:
        """v0.1.1: POST /sessions must populate sessions.invite_token + expiry."""
        client_a, _ = _login_as("alice@t07.local")
        r = client_a.post("/sessions", json={"name": "Bangkok"})
        sid = r.json()["id"]
        assert sid > 0

        # Verify via DB: token + expires_at + created_at all present.
        db = SessionLocal()
        try:
            row = db.query(SessionModel).filter_by(id=sid).one()
            assert row.invite_token, "invite_token should be populated on create"
            assert len(row.invite_token) >= 32, "token should be URL-safe 32 bytes"
            assert row.invite_expires_at is not None
            assert row.invite_created_at is not None
        finally:
            db.close()

        # Verify TTL via the API contract: GET /sessions/{id}/invite
        # returns ISO 8601 with tzinfo; parse and compare.
        r = client_a.get(f"/sessions/{sid}/invite")
        assert r.status_code == 200, r.text
        body = r.json()
        expires = datetime.fromisoformat(body["expires_at"])
        delta = expires.astimezone(timezone.utc) - datetime.now(timezone.utc)
        # 30 days +/- tolerance for test execution
        assert abs(delta - timedelta(days=30)) < timedelta(hours=1)

    def test_create_session_response_does_not_leak_token(self, client: TestClient) -> None:
        """v0.1.1: the SessionSummary response must NOT include invite_token.

        Tokens are fetched via GET /sessions/{id}/invite (member-only) so
        the list/create payloads stay compact.
        """
        client_a, _ = _login_as("alice@t07.local")
        r = client_a.post("/sessions", json={"name": "Bangkok"})
        body = r.json()
        assert "invite_token" not in body
        assert "invite_url" not in body


# ---------------------------------------------------------------------------
# TestListSessions
# ---------------------------------------------------------------------------


class TestListSessions:
    def test_list_returns_only_caller_sessions(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        a.post("/sessions", json={"name": "Trip A"})
        a.post("/sessions", json={"name": "Trip B"})
        b.post("/sessions", json={"name": "Bob Dinner"})

        r = a.get("/sessions")
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body, list)
        alice_only = [s for s in body if s["name"] in ("Trip A", "Trip B")]
        assert len(alice_only) == 2
        for s in alice_only:
            assert s["member_count"] == 1
            assert s["role"] == SessionRole.OWNER.value

    def test_list_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.get("/sessions")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# TestGetSession
# ---------------------------------------------------------------------------


class TestGetSession:
    def test_member_can_get_session_detail(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = a.get(f"/sessions/{sid}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["name"] == "Bangkok"
        assert len(body["members"]) == 1
        assert body["members"][0]["role"] == SessionRole.OWNER.value

    def test_non_member_gets_403(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_a = a.post("/sessions", json={"name": "A"}).json()["id"]
        r = b.get(f"/sessions/{sid_a}")
        assert r.status_code == 403

    def test_get_nonexistent_session_returns_403(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        r = a.get("/sessions/999999")
        assert r.status_code == 403  # session_isolation 403s first

    def test_get_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.get("/sessions/1")
        assert r.status_code == 401

    def test_owner_sees_invite_token_preview(self, client: TestClient) -> None:
        """v0.1.1: detail response includes invite_token_preview for owner only."""
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = a.get(f"/sessions/{sid}")
        body = r.json()
        assert body["invite_token_preview"], "owner must see invite_token_preview"
        assert body["invite_expires_at"], "owner must see invite_expires_at"

    def test_non_owner_does_not_see_invite_token_preview(self, client: TestClient) -> None:
        """v0.1.1: non-owner members get the detail without the token preview."""
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        # Make Bob a member so we can read detail as non-owner.
        db = SessionLocal()
        try:
            bob = db.query(User).filter_by(email="bob@t07.local").one()
            db.add(
                SessionMember(
                    session_id=sid,
                    user_id=bob.id,
                    display_name="Bob",
                    role=SessionRole.MEMBER.value,
                )
            )
            db.commit()
        finally:
            db.close()

        r = b.get(f"/sessions/{sid}")
        body = r.json()
        assert body["invite_token_preview"] is None
        assert body["invite_expires_at"] is None


# ---------------------------------------------------------------------------
# TestPatchMember
# ---------------------------------------------------------------------------


class TestPatchMember:
    def test_member_can_rename_self(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        members = a.get(f"/sessions/{sid}").json()["members"]
        mid = members[0]["id"]

        r = a.patch(f"/sessions/{sid}/members/{mid}", json={"display_name": "Alice in BKK"})
        assert r.status_code == 200, r.text
        assert r.json()["display_name"] == "Alice in BKK"

    def test_member_cannot_rename_other(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_b = b.post("/sessions", json={"name": "B"}).json()["id"]
        b_mid = (
            SessionLocal()
            .query(SessionMember)
            .filter_by(session_id=sid_b)
            .one()
            .id
        )

        r = a.patch(
            f"/sessions/{sid_b}/members/{b_mid}",
            json={"display_name": "hijack"},
        )
        assert r.status_code == 403

    def test_blank_display_name_returns_400(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        mid = a.get(f"/sessions/{sid}").json()["members"][0]["id"]
        r = a.patch(f"/sessions/{sid}/members/{mid}", json={"display_name": "   "})
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# TestGetSessionInvite  (v0.1.1: GET /sessions/{id}/invite, member-only)
# ---------------------------------------------------------------------------


class TestGetSessionInvite:
    def test_member_can_read_invite(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = a.get(f"/sessions/{sid}/invite")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["token"], "token must be present"
        assert body["url"] == f"/invites/{body['token']}"
        assert body["status"] == "active"
        assert "created_at" in body
        assert "expires_at" in body

    def test_non_member_gets_403(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = b.get(f"/sessions/{sid}/invite")
        assert r.status_code == 403, r.text

    def test_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.get("/sessions/1/invite")
        assert r.status_code == 401

    def test_expired_invite_returns_status_expired(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        # Backdate the invite expiry directly in DB.
        db = SessionLocal()
        try:
            row = db.query(SessionModel).filter_by(id=sid).one()
            row.invite_expires_at = datetime.now(timezone.utc) - timedelta(days=1)
            db.commit()
        finally:
            db.close()

        r = a.get(f"/sessions/{sid}/invite")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "expired"


# ---------------------------------------------------------------------------
# TestRotateSessionInvite  (v0.1.1: POST /sessions/{id}/invite/rotate, owner-only)
# ---------------------------------------------------------------------------


class TestRotateSessionInvite:
    def test_owner_can_rotate(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        original_token = a.get(f"/sessions/{sid}/invite").json()["token"]

        r = a.post(f"/sessions/{sid}/invite/rotate")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["token"] != original_token, "rotation must change the token"
        assert body["status"] == "active"
        assert "expires_at" in body

    def test_rotate_actually_persists_new_token(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        original_token = a.get(f"/sessions/{sid}/invite").json()["token"]

        a.post(f"/sessions/{sid}/invite/rotate")

        db = SessionLocal()
        try:
            row = db.query(SessionModel).filter_by(id=sid).one()
            assert row.invite_token != original_token
        finally:
            db.close()

    def test_member_cannot_rotate(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        # Make Bob a member (not owner).
        db = SessionLocal()
        try:
            bob = db.query(User).filter_by(email="bob@t07.local").one()
            db.add(
                SessionMember(
                    session_id=sid,
                    user_id=bob.id,
                    display_name="Bob",
                    role=SessionRole.MEMBER.value,
                )
            )
            db.commit()
        finally:
            db.close()

        r = b.post(f"/sessions/{sid}/invite/rotate")
        assert r.status_code == 403, r.text
        assert "owner" in r.json()["detail"]["error"].lower()

    def test_non_member_rotate_returns_403(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        r = b.post(f"/sessions/{sid}/invite/rotate")
        assert r.status_code == 403

    def test_rotate_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.post("/sessions/1/invite/rotate")
        assert r.status_code == 401

    def test_rotate_resets_expiry_to_30_days(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        # Backdate the expiry so we can confirm rotate pushes it forward.
        db = SessionLocal()
        try:
            row = db.query(SessionModel).filter_by(id=sid).one()
            row.invite_expires_at = datetime.now(timezone.utc) - timedelta(days=1)
            db.commit()
        finally:
            db.close()

        r = a.post(f"/sessions/{sid}/invite/rotate")
        expires = datetime.fromisoformat(r.json()["expires_at"])
        delta = expires.astimezone(timezone.utc) - datetime.now(timezone.utc)
        assert abs(delta - timedelta(days=30)) < timedelta(hours=1)


# ---------------------------------------------------------------------------
# TestGetInvitePublic  (v0.1.1: now seeded via SessionModel.invite_token)
# ---------------------------------------------------------------------------


class TestGetInvitePublic:
    def _make_session_with_invite(
        self,
        owner_email: str = "alice@t07.local",
        expired: bool = False,
    ) -> str:
        """Seed a session row (the v0.1.1 invite-token carrier) and return its token."""
        db = SessionLocal()
        try:
            owner = db.query(User).filter_by(email=owner_email).one()
            now = datetime.now(timezone.utc)
            token = secrets.token_urlsafe(32)
            session = SessionModel(
                name="Bangkok 2026",
                owner_user_id=owner.id,
                invite_token=token,
                invite_expires_at=(
                    now - timedelta(days=1) if expired else now + timedelta(days=30),
                ),
                session_code=secrets.token_hex(4),
                invite_created_at=now,
            )
            db.add(session)
            db.flush()
            db.add(
                SessionMember(
                    session_id=session.id,
                    user_id=owner.id,
                    display_name="Alice",
                    role=SessionRole.OWNER.value,
                )
            )
            db.commit()
            return token
        finally:
            db.close()

    def test_active_invite_returns_200(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        token = self._make_session_with_invite()
        r = client.get(f"/invites/{token}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["session_name"] == "Bangkok 2026"
        assert body["status"] == "active"
        assert body["inviter_display_name"] == "Alice"
        assert isinstance(body["session_id"], int)
        assert "expires_at" in body

    def test_expired_invite_returns_410(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        token = self._make_session_with_invite(expired=True)
        r = client.get(f"/invites/{token}")
        assert r.status_code == 410, r.text

    def test_rotated_away_token_returns_404(self, client: TestClient) -> None:
        """After rotation, the old token is not findable in DB -> 404."""
        _login_as("alice@t07.local")
        token = self._make_session_with_invite()
        # Simulate rotation by mutating the token directly.
        db = SessionLocal()
        try:
            db.query(SessionModel).update(
                {SessionModel.invite_token: secrets.token_urlsafe(32)}
            )
            db.commit()
        finally:
            db.close()
        r = client.get(f"/invites/{token}")
        assert r.status_code == 404

    def test_unknown_token_returns_404(self, client: TestClient) -> None:
        r = client.get("/invites/" + secrets.token_urlsafe(32))
        assert r.status_code == 404

    def test_invalid_token_format_returns_400(self, client: TestClient) -> None:
        r = client.get("/invites/short")
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# TestAcceptInvite  (v0.1.1: idempotent re-accept kept per PO i)
# ---------------------------------------------------------------------------


class TestAcceptInvite:
    def _make_session_with_invite(
        self, owner_email: str = "alice@t07.local"
    ) -> tuple[int, str]:
        db = SessionLocal()
        try:
            owner = db.query(User).filter_by(email=owner_email).one()
            token = secrets.token_urlsafe(32)
            now = datetime.now(timezone.utc)
            session = SessionModel(
                name="Bangkok",
                owner_user_id=owner.id,
                invite_token=token,
                invite_expires_at=now + timedelta(days=30),
                invite_created_at=now,
                session_code=secrets.token_hex(4),
)
            db.add(session)
            db.flush()
            db.add(
                SessionMember(
                    session_id=session.id,
                    user_id=owner.id,
                    display_name="Alice",
                    role=SessionRole.OWNER.value,
                )
            )
            db.commit()
            return session.id, token
        finally:
            db.close()

    def test_new_user_accepts(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        sid, token = self._make_session_with_invite()
        b, _ = _login_as("bob@t07.local")

        r = b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["session_id"] == sid
        assert body["role"] == SessionRole.MEMBER.value
        assert body["display_name"] == "Bob"
        assert "joined_at" in body

        r2 = b.get(f"/sessions/{sid}")
        assert r2.status_code == 200, r2.text
        members = r2.json()["members"]
        emails = sorted(m["email"] for m in members)
        assert emails == ["alice@t07.local", "bob@t07.local"]

    def test_already_member_returns_200_idempotent(self, client: TestClient) -> None:
        """PO i: accepted still works -- re-accepting returns the existing row."""
        _login_as("alice@t07.local")
        sid, token = self._make_session_with_invite()
        b, _ = _login_as("bob@t07.local")
        b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})

        # Same user accepts again -> 200, existing display_name preserved.
        r = b.post(f"/invites/{token}/accept", json={"display_name": "Bob2"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["role"] == SessionRole.MEMBER.value
        assert body["display_name"] == "Bob", "existing nickname must NOT be overwritten"

    def test_third_party_after_owner_invite_accepted_still_works(self, client: TestClient) -> None:
        """v0.1.1: the token is a session-wide URL -- multiple distinct users
        can accept the same token and each become a member (no "used_at"
        exclusivity like the old per-row design)."""
        _login_as("alice@t07.local")
        _, token = self._make_session_with_invite()

        b, _ = _login_as("bob@t07.local")
        c, _ = _login_as("carol@t07.local")

        r_b = b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})
        assert r_b.status_code == 200, r_b.text
        r_c = c.post(f"/invites/{token}/accept", json={"display_name": "Carol"})
        assert r_c.status_code == 200, r_c.text

    def test_expired_invite_returns_410(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        db = SessionLocal()
        try:
            alice = db.query(User).filter_by(email="alice@t07.local").one()
            token = secrets.token_urlsafe(32)
            session = SessionModel(
                name="Old",
                owner_user_id=alice.id,
                invite_token=token,
                invite_expires_at=datetime.now(timezone.utc) - timedelta(days=1),
                invite_created_at=datetime.now(timezone.utc),
                session_code=secrets.token_hex(4),
)
            db.add(session)
            db.flush()
            db.add(
                SessionMember(
                    session_id=session.id,
                    user_id=alice.id,
                    display_name="Alice",
                    role=SessionRole.OWNER.value,
                )
            )
            db.commit()
        finally:
            db.close()

        b, _ = _login_as("bob@t07.local")
        r = b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})
        assert r.status_code == 410, r.text

    def test_unknown_token_returns_404(self, client: TestClient) -> None:
        b, _ = _login_as("bob@t07.local")
        r = b.post(
            f"/invites/{secrets.token_urlsafe(32)}/accept",
            json={"display_name": "Bob"},
        )
        assert r.status_code == 404, r.text

    def test_blank_display_name_returns_400(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        _, token = self._make_session_with_invite()
        b, _ = _login_as("bob@t07.local")
        r = b.post(f"/invites/{token}/accept", json={"display_name": "   "})
        assert r.status_code == 400, r.text

    def test_accept_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.post(
            f"/invites/{secrets.token_urlsafe(32)}/accept",
            json={"display_name": "Bob"},
        )
        assert r.status_code == 401

    def test_invalid_token_format_returns_400(self, client: TestClient) -> None:
        b, _ = _login_as("bob@t07.local")
        r = b.post("/invites/short/accept", json={"display_name": "Bob"})
        assert r.status_code == 400

    def test_rotation_invalidates_old_token(self, client: TestClient) -> None:
        """v0.1.1: rotating the token makes the old token 404 (not 410)."""
        a, _ = _login_as("alice@t07.local")
        _, token = self._make_session_with_invite()
        # Use a's existing session by hitting the rotate endpoint.
        sessions = a.get("/sessions").json()
        sid = sessions[0]["id"]
        r = a.post(f"/sessions/{sid}/invite/rotate")
        assert r.status_code == 200, r.text

        b, _ = _login_as("bob@t07.local")
        r = b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})
        assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# TestSessionIsolation  (the headline: a member of A cannot touch B)
# ---------------------------------------------------------------------------


class TestSessionIsolation:
    def test_cannot_get_other_session(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_a = a.post("/sessions", json={"name": "A"}).json()["id"]
        sid_b = b.post("/sessions", json={"name": "B"}).json()["id"]

        r = a.get(f"/sessions/{sid_b}")
        assert r.status_code == 403

        r = a.get(f"/sessions/{sid_a}")
        assert r.status_code == 200

    def test_cannot_read_other_session_invite(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_b = b.post("/sessions", json={"name": "B"}).json()["id"]

        r = a.get(f"/sessions/{sid_b}/invite")
        assert r.status_code == 403

    def test_cannot_rotate_other_session_invite(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_b = b.post("/sessions", json={"name": "B"}).json()["id"]

        r = a.post(f"/sessions/{sid_b}/invite/rotate")
        assert r.status_code == 403

    def test_cannot_patch_other_session_member(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_b = b.post("/sessions", json={"name": "B"}).json()["id"]
        b_mid = (
            SessionLocal()
            .query(SessionMember)
            .filter_by(session_id=sid_b)
            .one()
            .id
        )

        r = a.patch(
            f"/sessions/{sid_b}/members/{b_mid}",
            json={"display_name": "hijack"},
        )
        assert r.status_code == 403
