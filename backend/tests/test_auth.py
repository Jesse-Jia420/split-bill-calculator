"""Tests for the T06 auth lifecycle (send-code DB path + verify + logout + me).

Strategy
--------
- We use the real SQLite test DB (``./data/sbc.db``) but **truncate the
  auth-related tables in a fixture** so each test starts clean.
- SMTP is mocked so no real network call happens.
- ``TestClient`` exercises the live FastAPI app (routers, deps, etc.).
- Where we need to inspect the verification code that "would have been
  sent", we read it back from the DB after the call.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.auth import COOKIE_NAME, hash_token
from app.core.config import Settings, get_settings
from app.db.models.auth_tokens import AuthToken
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
def _truncate_auth_tables():
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return
    """Reset users / auth_tokens / verification_codes between tests.

    The 9-table migration is applied once at startup; here we just empty
    the rows we touch so each test sees a clean slate.
    """
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        db.query(AuthToken).delete()
        db.query(VerificationCode).delete()
        db.query(User).delete()
        db.commit()
    finally:
        db.close()
    yield
    # No teardown — next test starts by truncating again.


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


def _make_code_row(email: str, code: str, *, used: bool = False,
                   minutes_ago: int = 0, ttl_minutes: int = 10) -> VerificationCode:
    """Helper: build & persist a VerificationCode row directly."""
    from app.core.database import SessionLocal

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=ttl_minutes - minutes_ago)
    row = VerificationCode(
        email=email,
        code=code,
        purpose=VerificationPurpose.MAGIC_LINK.value,
        session_id=None,
        expires_at=expires_at,
        used=used,
    )
    # Backdate created_at for rate-limit / age tests.
    row.created_at = now - timedelta(minutes=minutes_ago)
    db = SessionLocal()
    try:
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    finally:
        db.close()


def _read_code_for(email: str) -> str | None:
    """Return the latest *unused* MAGIC_LINK code for the given email.

    Falls back to the latest row of any kind if no unused one exists,
    so callers can assert against the most recent issued code in tests.
    """
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        unused = (
            db.query(VerificationCode)
            .filter(
                VerificationCode.email == email,
                VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
                VerificationCode.used.is_(False),
            )
            .order_by(VerificationCode.created_at.desc())
            .first()
        )
        if unused is not None:
            return unused.code
        any_row = (
            db.query(VerificationCode)
            .filter(
                VerificationCode.email == email,
                VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
            )
            .order_by(VerificationCode.created_at.desc())
            .first()
        )
        return any_row.code if any_row else None
    finally:
        db.close()


def _read_token_hashes_for(user_email: str) -> list[str]:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        user = db.query(User).filter_by(email=user_email).first()
        if user is None:
            return []
        return [t.token_hash for t in user.auth_tokens]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# /auth/send-code — DB-backed
# ---------------------------------------------------------------------------


class TestSendCodeRateLimit:
    def test_sixth_request_within_hour_returns_429(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "ratelimit@example.com"
        # 5 prior successful sends within the window.
        for _ in range(5):
            r = client.post("/auth/send-code", json={"email": email})
            assert r.status_code == 200, r.text

        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 429, r.text
        detail = r.json().get("detail", {})
        assert detail.get("error") == "rate limit exceeded"
        assert isinstance(detail.get("retry_after_minutes"), int)
        assert 1 <= detail["retry_after_minutes"] <= 60

    def test_retry_after_minutes_reflects_oldest_row_age(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "retry@example.com"
        # Insert 5 rows manually: oldest is 50 minutes old.
        _make_code_row(email, "111111", minutes_ago=50)
        for _ in range(4):
            _make_code_row(email, "111111", minutes_ago=10)

        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 429, r.text
        detail = r.json().get("detail", {})
        # Oldest is 50 min old; window is 60 min — retry ~10 min.
        assert detail.get("retry_after_minutes") is not None
        # Allow ±2 min slack for test-runtime rounding.
        assert 8 <= detail["retry_after_minutes"] <= 12

    def test_codes_older_than_window_are_cleaned_before_insert(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        # Pre-seed 3 rows older than the rate-limit window (created >1h ago).
        email = "cleanup@example.com"
        for i in range(3):
            _make_code_row(email, f"90{i:04d}", minutes_ago=70, ttl_minutes=10)

        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 200, r.text

        from app.core.database import SessionLocal
        db = SessionLocal()
        try:
            rows = (
                db.query(VerificationCode)
                .filter(
                    VerificationCode.email == email,
                    VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
                )
                .all()
            )
            assert len(rows) == 1
        finally:
            db.close()

    def test_unused_codes_inside_window_are_kept_for_rate_limit(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "keep@example.com"
        for i in range(3):
            _make_code_row(email, f"10{i:04d}", minutes_ago=2, ttl_minutes=10)

        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 200, r.text

        from app.core.database import SessionLocal
        db = SessionLocal()
        try:
            rows = (
                db.query(VerificationCode)
                .filter(
                    VerificationCode.email == email,
                    VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
                )
                .all()
            )
            # 3 pre-existing + 1 new = 4 rows.
            assert len(rows) == 4
        finally:
            db.close()

    def test_send_code_persists_row_and_returns_200(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "persist@example.com"
        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["sent"] is True
        assert body["email"] == email
        assert body["ttl_minutes"] == get_settings().verification_code_ttl_minutes

        code = _read_code_for(email)
        assert code is not None
        assert len(code) == 6
        assert code.isdigit()


# ---------------------------------------------------------------------------
# /auth/verify-code
# ---------------------------------------------------------------------------


class TestVerifyCode:
    def test_valid_code_returns_200_and_sets_cookie(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "verify-ok@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)
        assert code is not None

        r = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == email
        assert "user_id" in body
        assert "default_name" in body
        assert "auth_token_expires_at" in body

        # Cookie must be set with the right attributes.
        set_cookie = r.headers.get("set-cookie", "")
        assert COOKIE_NAME in set_cookie
        assert "HttpOnly" in set_cookie
        assert "SameSite=Lax" in set_cookie or "samesite=lax" in set_cookie.lower()
        assert "Path=/" in set_cookie

    def test_wrong_code_returns_401(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "wrong@example.com"
        client.post("/auth/send-code", json={"email": email})
        # Read the actual code, then send a different one.
        _ = _read_code_for(email)

        r = client.post("/auth/verify-code", json={"email": email, "code": "000000"})
        assert r.status_code == 401, r.text
        assert "invalid or expired" in r.json().get("detail", {}).get("error", "")

    def test_used_code_returns_401(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "used@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)

        # First verify succeeds.
        r1 = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert r1.status_code == 200, r1.text

        # Re-using the same code fails.
        r2 = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert r2.status_code == 401, r2.text

    def test_expired_code_returns_401(self, client: TestClient) -> None:
        email = "expired@example.com"
        # Insert a row whose expires_at is already in the past.
        _make_code_row(email, "123456", ttl_minutes=-1)

        r = client.post("/auth/verify-code", json={"email": email, "code": "123456"})
        assert r.status_code == 401, r.text

    def test_new_email_auto_registers_user(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "fresh@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)

        r = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert r.status_code == 200, r.text
        body = r.json()
        # default_name = local-part of email.
        assert body["default_name"] == "fresh"

        # User row exists in DB.
        from app.core.database import SessionLocal
        db = SessionLocal()
        try:
            user = db.query(User).filter_by(email=email).first()
            assert user is not None
            assert user.default_name == "fresh"
        finally:
            db.close()

    def test_existing_user_returns_same_id(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "existing@example.com"
        # First login: register.
        client.post("/auth/send-code", json={"email": email})
        code1 = _read_code_for(email)
        r1 = client.post("/auth/verify-code", json={"email": email, "code": code1})
        assert r1.status_code == 200
        user_id_1 = r1.json()["user_id"]

        # Second login: should NOT create a new user.
        client.post("/auth/send-code", json={"email": email})
        code2 = _read_code_for(email)
        r2 = client.post("/auth/verify-code", json={"email": email, "code": code2})
        assert r2.status_code == 200
        user_id_2 = r2.json()["user_id"]
        assert user_id_1 == user_id_2


# ---------------------------------------------------------------------------
# /auth/logout
# ---------------------------------------------------------------------------


class TestLogout:
    def test_logout_with_valid_cookie_deletes_token_and_returns_200(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "logout@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)
        v = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert v.status_code == 200
        token_hash = _read_token_hashes_for(email)[0]

        r = client.post("/auth/logout")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["logged_out"] is True

        # Token row deleted.
        assert _read_token_hashes_for(email) == []
        # Set-Cookie header should clear the cookie.
        set_cookie = r.headers.get("set-cookie", "")
        assert COOKIE_NAME in set_cookie
        assert "Max-Age=0" in set_cookie or "max-age=0" in set_cookie.lower()

    def test_logout_without_cookie_returns_200(
        self, client: TestClient
    ) -> None:
        """Missing cookie is not an error — we just clear it."""
        r = client.post("/auth/logout")
        assert r.status_code == 200, r.text
        assert r.json() == {"logged_out": True}

    def test_logout_with_invalid_cookie_returns_200(
        self, client: TestClient
    ) -> None:
        """Forged / unknown cookie is also not surfaced to the client."""
        client.cookies.set(COOKIE_NAME, "not-a-real-token-xxxxxx")
        r = client.post("/auth/logout")
        assert r.status_code == 200, r.text
        assert r.json() == {"logged_out": True}


# ---------------------------------------------------------------------------
# /auth/me
# ---------------------------------------------------------------------------


class TestGetMe:
    def test_valid_cookie_returns_current_user(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "me@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)
        v = client.post("/auth/verify-code", json={"email": email, "code": code})
        # Carry the cookie forward into subsequent calls.
        cookies = v.cookies

        r = client.get("/auth/me", cookies=cookies)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == email
        assert "user_id" in body
        assert body["default_name"] == "me"

    def test_no_cookie_returns_401(self, client: TestClient) -> None:
        r = client.get("/auth/me")
        assert r.status_code == 401, r.text
        assert r.json().get("detail", {}).get("error") == "not authenticated"

    def test_expired_token_returns_401(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "expired-token@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)
        v = client.post("/auth/verify-code", json={"email": email, "code": code})
        # Pull the raw token out of the response cookies.
        raw = v.cookies.get(COOKIE_NAME)
        assert raw is not None

        # Backdate the token's expiry directly in the DB.
        from app.core.database import SessionLocal

        db = SessionLocal()
        try:
            row = db.query(AuthToken).filter_by(token_hash=hash_token(raw)).first()
            assert row is not None
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.commit()
        finally:
            db.close()

        r = client.get("/auth/me", cookies={COOKIE_NAME: raw})
        assert r.status_code == 401, r.text


# ---------------------------------------------------------------------------
# get_current_user dependency (unit-level)
# ---------------------------------------------------------------------------


class TestGetCurrentUserDependency:
    def test_valid_cookie_returns_user(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "dep@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)
        v = client.post("/auth/verify-code", json={"email": email, "code": code})
        raw = v.cookies.get(COOKIE_NAME)
        assert raw is not None

        # /auth/me is the live exercise of the dependency.
        r = client.get("/auth/me", cookies={COOKIE_NAME: raw})
        assert r.status_code == 200

    def test_invalid_cookie_raises_401(self, client: TestClient) -> None:
        client.cookies.set(COOKIE_NAME, "this-is-not-a-real-token")
        r = client.get("/auth/me")
        assert r.status_code == 401

    def test_hash_token_is_sha256_hex(self) -> None:
        # 64-hex sha256.
        h = hash_token("hello")
        assert len(h) == 64
        assert h == hashlib.sha256(b"hello").hexdigest()


# ---------------------------------------------------------------------------
# Auth integration (multi-device etc.)
# ---------------------------------------------------------------------------


class TestAuthIntegration:
    def test_full_flow_send_then_verify_then_me(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "flow@example.com"
        # 1. Request code.
        r1 = client.post("/auth/send-code", json={"email": email})
        assert r1.status_code == 200
        # 2. Verify code.
        code = _read_code_for(email)
        r2 = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert r2.status_code == 200
        cookies = r2.cookies
        # 3. Hit /auth/me with the cookie.
        r3 = client.get("/auth/me", cookies=cookies)
        assert r3.status_code == 200
        assert r3.json()["email"] == email

    def test_multi_device_login_coexists(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        """Two verify-code calls → two AuthTokens, both valid (F2)."""
        email = "multi-device@example.com"
        # Login #1
        client.post("/auth/send-code", json={"email": email})
        c1 = _read_code_for(email)
        v1 = client.post("/auth/verify-code", json={"email": email, "code": c1})
        raw1 = v1.cookies.get(COOKIE_NAME)
        assert v1.status_code == 200

        # Login #2 (different "device" = different cookie jar)
        client.post("/auth/send-code", json={"email": email})
        c2 = _read_code_for(email)
        v2 = client.post("/auth/verify-code", json={"email": email, "code": c2})
        raw2 = v2.cookies.get(COOKIE_NAME)
        assert v2.status_code == 200

        assert raw1 != raw2, "each verify must mint a fresh raw token"
        # Both cookies resolve to valid sessions.
        me1 = client.get("/auth/me", cookies={COOKIE_NAME: raw1})
        me2 = client.get("/auth/me", cookies={COOKIE_NAME: raw2})
        assert me1.status_code == 200 and me2.status_code == 200
        assert me1.json()["user_id"] == me2.json()["user_id"]

        # Two AuthToken rows in DB.
        assert len(_read_token_hashes_for(email)) == 2

    def test_logout_only_invalidates_one_device(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "shared@example.com"
        # Login #1
        client.post("/auth/send-code", json={"email": email})
        c1 = _read_code_for(email)
        v1 = client.post("/auth/verify-code", json={"email": email, "code": c1})
        raw1 = v1.cookies.get(COOKIE_NAME)

        # Login #2
        client.post("/auth/send-code", json={"email": email})
        c2 = _read_code_for(email)
        v2 = client.post("/auth/verify-code", json={"email": email, "code": c2})
        raw2 = v2.cookies.get(COOKIE_NAME)

        # Logout device #1.
        r = client.post("/auth/logout", cookies={COOKIE_NAME: raw1})
        assert r.status_code == 200

        # Device #1 → 401, device #2 → still 200.
        me1 = client.get("/auth/me", cookies={COOKIE_NAME: raw1})
        me2 = client.get("/auth/me", cookies={COOKIE_NAME: raw2})
        assert me1.status_code == 401
        assert me2.status_code == 200

    def test_after_logout_me_returns_401(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "after-logout@example.com"
        client.post("/auth/send-code", json={"email": email})
        code = _read_code_for(email)
        v = client.post("/auth/verify-code", json={"email": email, "code": code})
        cookies = v.cookies

        client.post("/auth/logout", cookies=cookies)
        r = client.get("/auth/me", cookies=cookies)
        assert r.status_code == 401
