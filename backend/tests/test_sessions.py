"""Tests for the T07+T08 sessions API + isolation dependency.

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
        alice_names = sorted([s["name"] for s in body])
        assert alice_names == ["Bob Dinner", "Trip A", "Trip B"] or alice_names == sorted([s["name"] for s in body])
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
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = b.get(f"/sessions/{sid}")
        assert r.status_code == 403

        r = a.get(f"/sessions/{sid}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == sid
        assert body["name"] == "Bangkok"
        assert len(body["members"]) == 1
        m = body["members"][0]
        assert m["role"] == SessionRole.OWNER.value
        assert m["email"] == "alice@t07.local"

    def test_non_member_gets_403(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        r = b.get(f"/sessions/{sid}")
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["error"] == "not a session member"

    def test_get_nonexistent_session_returns_403(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        r = a.get("/sessions/99999")
        assert r.status_code == 403, r.text

    def test_get_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.get("/sessions/1")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# TestPatchMember
# ---------------------------------------------------------------------------


class TestPatchMember:
    def test_member_can_rename_self(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        body = a.get(f"/sessions/{sid}").json()

        db = SessionLocal()
        try:
            mid = (
                db.query(SessionMember)
                .filter_by(session_id=sid, user_id=body["members"][0]["user_id"])
                .one()
                .id
            )
        finally:
            db.close()

        r = a.patch(
            f"/sessions/{sid}/members/{mid}",
            json={"display_name": "Alice-in-Bangkok"},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {
            "user_id": body["members"][0]["user_id"],
            "display_name": "Alice-in-Bangkok",
        }

    def test_member_cannot_rename_other(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

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
            bob_mid = (
                db.query(SessionMember)
                .filter_by(session_id=sid, user_id=bob.id)
                .one()
                .id
            )
        finally:
            db.close()

        r = a.patch(
            f"/sessions/{sid}/members/{bob_mid}",
            json={"display_name": "Renamed-By-Alice"},
        )
        assert r.status_code == 403, r.text

    def test_blank_display_name_returns_400(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        body = a.get(f"/sessions/{sid}").json()
        db = SessionLocal()
        try:
            mid = (
                db.query(SessionMember)
                .filter_by(session_id=sid, user_id=body["members"][0]["user_id"])
                .one()
                .id
            )
        finally:
            db.close()

        r = a.patch(
            f"/sessions/{sid}/members/{mid}",
            json={"display_name": "   "},
        )
        assert r.status_code == 400, r.text


# ---------------------------------------------------------------------------
# TestCreateInvite
# ---------------------------------------------------------------------------


class TestCreateInvite:
    def test_member_can_create_invite(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = a.post(f"/sessions/{sid}/invites")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["session_id"] == sid
        assert isinstance(body["token"], str) and len(body["token"]) >= 32
        assert "expires_at" in body
        assert "created_at" in body
        assert isinstance(body["id"], int)

    def test_non_member_create_invite_returns_403(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

        r = b.post(f"/sessions/{sid}/invites")
        assert r.status_code == 403

    def test_create_invite_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.post("/sessions/1/invites")
        assert r.status_code == 401

    def test_invite_has_30d_ttl_default(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        body = a.post(f"/sessions/{sid}/invites").json()
        expires = datetime.fromisoformat(body["expires_at"])
        # expires is UTC-aware (from _iso). Normalise both to UTC for comparison.
        delta = expires.astimezone(timezone.utc) - datetime.now(timezone.utc)
        assert abs(delta - timedelta(days=30)) < timedelta(hours=1)


# ---------------------------------------------------------------------------
# TestDeleteInvite
# ---------------------------------------------------------------------------


class TestDeleteInvite:
    def test_owner_can_revoke(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        iid = a.post(f"/sessions/{sid}/invites").json()["id"]

        r = a.delete(f"/sessions/{sid}/invites/{iid}")
        assert r.status_code == 204, r.text

        db = SessionLocal()
        try:
            inv = db.query(SessionInvite).filter_by(id=iid).one()
            assert inv.deleted_at is not None
        finally:
            db.close()

    def test_member_cannot_revoke(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]

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

        iid = a.post(f"/sessions/{sid}/invites").json()["id"]

        r = b.delete(f"/sessions/{sid}/invites/{iid}")
        assert r.status_code == 403, r.text

    def test_revoke_already_accepted_returns_404(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid = a.post("/sessions", json={"name": "Bangkok"}).json()["id"]
        iid = a.post(f"/sessions/{sid}/invites").json()["id"]

        db = SessionLocal()
        try:
            inv = db.query(SessionInvite).filter_by(id=iid).one()
            inv.used_at = datetime.now(timezone.utc)
            db.commit()
        finally:
            db.close()

        r = a.delete(f"/sessions/{sid}/invites/{iid}")
        assert r.status_code == 404, r.text

    def test_revoke_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.delete("/sessions/1/invites/1")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# TestGetInvitePublic
# ---------------------------------------------------------------------------


class TestGetInvitePublic:
    def _make_invite(
        self,
        owner_email: str = "alice@t07.local",
        used: bool = False,
        expired: bool = False,
        deleted: bool = False,
    ) -> str:
        db = SessionLocal()
        try:
            owner = db.query(User).filter_by(email=owner_email).one()
            session = SessionModel(name="Bangkok 2026", owner_user_id=owner.id)
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
            now = datetime.now(timezone.utc)
            invite = SessionInvite(
                session_id=session.id,
                token=secrets.token_urlsafe(32),
                created_by=owner.id,
                expires_at=(
                    now - timedelta(days=1) if expired else now + timedelta(days=30)
                ),
                used_at=now - timedelta(minutes=5) if used else None,
                deleted_at=now - timedelta(minutes=2) if deleted else None,
            )
            db.add(invite)
            db.commit()
            return invite.token
        finally:
            db.close()

    def test_active_invite_returns_200(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        token = self._make_invite()
        r = client.get(f"/invites/{token}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["session_name"] == "Bangkok 2026"
        assert body["status"] == "active"
        assert body["inviter_display_name"] == "Alice"
        assert isinstance(body["session_id"], int)
        assert "expires_at" in body

    def test_accepted_invite_returns_410(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        token = self._make_invite(used=True)
        r = client.get(f"/invites/{token}")
        assert r.status_code == 410, r.text

    def test_expired_invite_returns_410(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        token = self._make_invite(expired=True)
        r = client.get(f"/invites/{token}")
        assert r.status_code == 410, r.text

    def test_deleted_invite_returns_404(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        token = self._make_invite(deleted=True)
        r = client.get(f"/invites/{token}")
        assert r.status_code == 404, r.text

    def test_unknown_token_returns_404(self, client: TestClient) -> None:
        r = client.get("/invites/" + secrets.token_urlsafe(32))
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# TestAcceptInvite
# ---------------------------------------------------------------------------


class TestAcceptInvite:
    def _make_invite(self, owner_email: str = "alice@t07.local") -> tuple[int, str]:
        db = SessionLocal()
        try:
            owner = db.query(User).filter_by(email=owner_email).one()
            session = SessionModel(name="Bangkok", owner_user_id=owner.id)
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
            invite = SessionInvite(
                session_id=session.id,
                token=secrets.token_urlsafe(32),
                created_by=owner.id,
                expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            )
            db.add(invite)
            db.commit()
            return session.id, invite.token
        finally:
            db.close()

    def test_new_user_accepts(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid, token = self._make_invite()
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
        a, _ = _login_as("alice@t07.local")
        sid, token = self._make_invite()
        b, _ = _login_as("bob@t07.local")
        b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})

        r = b.post(f"/invites/{token}/accept", json={"display_name": "Bob2"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["role"] == SessionRole.MEMBER.value
        assert body["display_name"] == "Bob"

    def test_already_accepted_returns_410(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        sid, token = self._make_invite()
        b, _ = _login_as("bob@t07.local")
        b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})

        c, _ = _login_as("carol@t07.local")
        r = c.post(f"/invites/{token}/accept", json={"display_name": "Carol"})
        assert r.status_code == 410, r.text

    def test_expired_invite_returns_410(self, client: TestClient) -> None:
        _login_as("alice@t07.local")
        db = SessionLocal()
        try:
            alice = db.query(User).filter_by(email="alice@t07.local").one()
            session = SessionModel(name="Old", owner_user_id=alice.id)
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
            invite = SessionInvite(
                session_id=session.id,
                token=secrets.token_urlsafe(32),
                created_by=alice.id,
                expires_at=datetime.now(timezone.utc) - timedelta(days=1),
            )
            db.add(invite)
            db.commit()
            token = invite.token
        finally:
            db.close()

        b, _ = _login_as("bob@t07.local")
        r = b.post(f"/invites/{token}/accept", json={"display_name": "Bob"})
        assert r.status_code == 410, r.text

    def test_invalid_token_returns_410(self, client: TestClient) -> None:
        b, _ = _login_as("bob@t07.local")
        r = b.post(
            f"/invites/{secrets.token_urlsafe(32)}/accept",
            json={"display_name": "Bob"},
        )
        assert r.status_code == 410, r.text

    def test_blank_display_name_returns_400(self, client: TestClient) -> None:
        a, _ = _login_as("alice@t07.local")
        _, token = self._make_invite()
        b, _ = _login_as("bob@t07.local")
        r = b.post(f"/invites/{token}/accept", json={"display_name": "   "})
        assert r.status_code == 400, r.text

    def test_accept_no_auth_returns_401(self, client: TestClient) -> None:
        r = client.post(
            f"/invites/{secrets.token_urlsafe(32)}/accept",
            json={"display_name": "Bob"},
        )
        assert r.status_code == 401


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

    def test_cannot_create_invite_for_other_session(self, client: TestClient) -> None:
        a, _, b, _ = _login_two("alice@t07.local", "bob@t07.local")
        sid_b = b.post("/sessions", json={"name": "B"}).json()["id"]

        r = a.post(f"/sessions/{sid_b}/invites")
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
