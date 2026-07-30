"""Product rules: invalidate anon secret on login bind; one seat per user;
expired ledgers are logically deleted (archived) and blocked.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

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


@pytest.fixture(autouse=True)
def _truncate_all():
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


def _make_user(email: str) -> User:
    db = SessionLocal()
    try:
        user = User(email=email, default_name=email.split("@")[0][:120])
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        db.close()


def _login(client: TestClient, user: User) -> None:
    db = SessionLocal()
    try:
        raw = secrets.token_hex(32)
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
    client.cookies.set(COOKIE_NAME, raw)


def _make_anon_session(
    *,
    display_name: str = "我",
    last_active_at: datetime | None = None,
    archived: bool = False,
) -> tuple[int, int, str]:
    """Return (session_id, member_id, nickname_secret)."""
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        session = SessionModel(
            name="trip",
            primary_currency="CNY",
            currencies=["CNY"],
            owner_user_id=None,
            owner_email=None,
            last_active_at=last_active_at or now,
            archived=archived,
            session_code=secrets.token_hex(5).upper()[:10],
            invite_token=secrets.token_urlsafe(32),
            invite_expires_at=now + timedelta(days=30),
            invite_created_at=now,
        )
        db.add(session)
        db.flush()
        secret = secrets.token_hex(32)
        sm = SessionMember(
            session_id=session.id,
            user_id=None,
            display_name=display_name,
            role=SessionRole.OWNER.value,
            is_anon=True,
            nickname_secret=secret,
            claimed_at=now,
        )
        db.add(sm)
        db.commit()
        return session.id, sm.id, secret
    finally:
        db.close()


class TestInvalidateAnonSecretOnBind:
    def test_bind_clears_nickname_secret(self, client: TestClient):
        sid, mid, secret = _make_anon_session()
        user = _make_user("bind@example.com")
        _login(client, user)

        r = client.post(
            f"/sessions/{sid}/bind-acting-member",
            json={"nickname_secret": secret},
        )
        assert r.status_code == 200, r.text
        assert r.json()["session_member_id"] == mid

        db = SessionLocal()
        try:
            sm = db.get(SessionMember, mid)
            assert sm is not None
            assert sm.user_id == user.id
            assert sm.is_anon is False
            assert sm.nickname_secret is None
        finally:
            db.close()

        # Stale secret can no longer authenticate.
        r2 = client.get(
            f"/sessions/{sid}/bills",
            headers={"X-Nickname-Secret": secret},
        )
        # Logged-in cookie still works; drop cookie to prove secret alone fails.
        client.cookies.clear()
        r3 = client.get(
            f"/sessions/{sid}/bills",
            headers={"X-Nickname-Secret": secret},
        )
        assert r3.status_code == 403

    def test_logged_in_claim_clears_secret(self, client: TestClient):
        sid, mid, secret = _make_anon_session(display_name="小红")
        # Add a second empty slot is not needed — claim the anon seat while logged in.
        user = _make_user("claim@example.com")
        _login(client, user)

        r = client.post(
            f"/sessions/{sid}/join-claim",
            json={"action": "claim", "session_member_id": mid},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["nickname_secret"] is None

        db = SessionLocal()
        try:
            sm = db.get(SessionMember, mid)
            assert sm.nickname_secret is None
            assert sm.user_id == user.id
        finally:
            db.close()


class TestOneUserOneSeat:
    def test_cannot_claim_second_nickname(self, client: TestClient):
        sid, mid, _secret = _make_anon_session(display_name="座位A")
        db = SessionLocal()
        try:
            other = SessionMember(
                session_id=sid,
                user_id=None,
                display_name="座位B",
                role=SessionRole.MEMBER.value,
                is_anon=True,
                nickname_secret=None,
                claimed_at=None,
            )
            db.add(other)
            db.commit()
            other_id = other.id
        finally:
            db.close()

        user = _make_user("oneseats@example.com")
        _login(client, user)

        r1 = client.post(
            f"/sessions/{sid}/join-claim",
            json={"action": "claim", "session_member_id": mid},
        )
        assert r1.status_code == 200, r1.text

        r2 = client.post(
            f"/sessions/{sid}/join-claim",
            json={"action": "claim", "session_member_id": other_id},
        )
        assert r2.status_code == 409
        assert r2.json()["detail"]["error"] == "already_a_member"

    def test_cannot_add_second_nickname(self, client: TestClient):
        sid, mid, _secret = _make_anon_session()
        user = _make_user("addtwo@example.com")
        _login(client, user)

        r1 = client.post(
            f"/sessions/{sid}/join-claim",
            json={"action": "claim", "session_member_id": mid},
        )
        assert r1.status_code == 200, r1.text

        r2 = client.post(
            f"/sessions/{sid}/join-claim",
            json={"action": "add", "display_name": "另一个我"},
        )
        assert r2.status_code == 409
        assert r2.json()["detail"]["error"] == "already_a_member"


class TestExpiredLogicalDelete:
    def test_expired_archives_and_blocks_secret(self, client: TestClient):
        stale = datetime.now(timezone.utc) - timedelta(days=8)
        sid, _mid, secret = _make_anon_session(last_active_at=stale)

        r = client.get(
            f"/sessions/{sid}/bills",
            headers={"X-Nickname-Secret": secret},
        )
        assert r.status_code == 410
        detail = r.json()["detail"]
        assert detail["code"] in ("session_reclaimed", "session_archived")

        db = SessionLocal()
        try:
            session = db.get(SessionModel, sid)
            assert session is not None
            assert session.archived is True
        finally:
            db.close()

        # Second hit: already archived.
        r2 = client.get(
            f"/sessions/{sid}/bills",
            headers={"X-Nickname-Secret": secret},
        )
        assert r2.status_code == 410
        assert r2.json()["detail"]["code"] == "session_archived"

    def test_list_sessions_hides_archived(self, client: TestClient):
        user = _make_user("list@example.com")
        _login(client, user)

        db = SessionLocal()
        try:
            now = datetime.now(timezone.utc)
            live = SessionModel(
                name="live",
                primary_currency="CNY",
                currencies=["CNY"],
                owner_user_id=user.id,
                owner_email=user.email,
                last_active_at=now,
                archived=False,
                session_code="LIVECODE01",
                invite_token=secrets.token_urlsafe(32),
                invite_expires_at=now + timedelta(days=30),
                invite_created_at=now,
            )
            dead = SessionModel(
                name="dead",
                primary_currency="CNY",
                currencies=["CNY"],
                owner_user_id=user.id,
                owner_email=user.email,
                last_active_at=now,
                archived=True,
                session_code="DEADCODE01",
                invite_token=secrets.token_urlsafe(32),
                invite_expires_at=now + timedelta(days=30),
                invite_created_at=now,
            )
            db.add_all([live, dead])
            db.flush()
            db.add_all(
                [
                    SessionMember(
                        session_id=live.id,
                        user_id=user.id,
                        display_name="我",
                        role=SessionRole.OWNER.value,
                        is_anon=False,
                    ),
                    SessionMember(
                        session_id=dead.id,
                        user_id=user.id,
                        display_name="我",
                        role=SessionRole.OWNER.value,
                        is_anon=False,
                    ),
                ]
            )
            db.commit()
            live_id = live.id
        finally:
            db.close()

        r = client.get("/sessions")
        assert r.status_code == 200
        ids = {row["id"] for row in r.json()}
        assert live_id in ids
        assert all(row["name"] != "dead" for row in r.json())
