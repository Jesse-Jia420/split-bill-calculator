"""Unit tests for ``DEV_BYPASS_EMAILS`` (v0.1.4 full-bypass, option B).

Strategy
--------
- The bypass list is computed once at import time of
  ``app.api.auth`` from the ``DEV_BYPASS_EMAILS`` env var. Tests rely
  on ``tests/conftest.py`` seeding that var before any test module is
  imported (so the constant is non-empty by the time these tests run).
- SMTP is mocked (same pattern as ``test_auth_flow.py``) so the
  non-bypass path doesn't talk to a real Gmail.
- Verification code rows are read back from the DB to assert the
  bypass audit trail (one row per verify-code call, all marked used).
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.api.auth import DEV_BYPASS_EMAILS
from app.core.database import SessionLocal
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


@pytest.fixture(autouse=True)
def _truncate_auth_tables():
    """Reset users / auth_tokens / verification_codes between tests."""
    db = SessionLocal()
    try:
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
def db():
    """Direct DB session for assertions."""
    db_session = SessionLocal()
    try:
        yield db_session
    finally:
        db_session.close()


@pytest.fixture
def mock_email_service():
    """Patch EmailService so /auth/send-code does not talk to a real SMTP."""
    with patch("app.api.auth.EmailService") as mock_cls:
        instance: Any = mock_cls.return_value

        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        instance.send_verification_code.side_effect = _noop
        yield mock_cls


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestBypassSetMembership:
    """The bypass set must contain the live test email."""

    def test_bypass_email_in_dev_set(self):
        assert "xinhua1001@outlook.com" in DEV_BYPASS_EMAILS

    def test_bypass_set_is_lowercased(self):
        # The CSV loader lowercases entries; sanity check that the
        # canonical email is reachable regardless of source casing.
        assert all(e == e.lower() for e in DEV_BYPASS_EMAILS)
        assert "XINHUA1001@OUTLOOK.COM" not in DEV_BYPASS_EMAILS


class TestBypassSendCodeAndVerifyCode:
    """Verify-code bypass accepts ANY 6-digit code and writes an audit row."""

    def test_bypass_send_code_skips_db_and_smtp(
        self, client: TestClient, db
    ) -> None:
        """send-code on a bypass email: 200 + no row written + no SMTP."""
        email = "xinhua1001@outlook.com"

        with patch("app.api.auth.EmailService") as mock_cls:
            r = client.post("/auth/send-code", json={"email": email})
            assert r.status_code == 200, r.text
            body = r.json()
            # Same shape as the normal send-code response.
            assert body["sent"] is True
            assert body["email"] == email
            assert isinstance(body["ttl_minutes"], int)
            # EmailService must NOT be instantiated for the bypass path.
            mock_cls.assert_not_called()

        # No verification_codes row should be written for this email.
        rows = db.query(VerificationCode).filter_by(email=email).all()
        assert rows == []

    def test_bypass_verify_accepts_arbitrary_code(
        self, client: TestClient, db
    ) -> None:
        """verify-code on a bypass email: any 6-digit code => 200 + cookie."""
        email = "xinhua1001@outlook.com"

        # First, send-code (bypass — no row written, but client gets 200).
        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 200, r.text

        # Now verify with an arbitrary code "999999" (no real code exists).
        r = client.post(
            "/auth/verify-code",
            json={"email": email, "code": "999999"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == email
        assert body["default_name"] == "xinhua1001"
        assert isinstance(body["user_id"], int)
        assert "auth_token_expires_at" in body

        # Set-Cookie carries the session cookie.
        set_cookie = r.headers.get("set-cookie", "")
        assert "sbc_session" in set_cookie
        assert "HttpOnly" in set_cookie

        # Audit trail: exactly one row for this email, used=True.
        rows = db.query(VerificationCode).filter_by(email=email).all()
        assert len(rows) == 1
        assert rows[0].used is True
        assert rows[0].code == "000000"  # bypass placeholder
        assert rows[0].purpose == VerificationPurpose.MAGIC_LINK.value

    def test_bypass_verify_with_other_arbitrary_code(
        self, client: TestClient, db
    ) -> None:
        """A second verify uses a different code; both produce audit rows."""
        email = "xinhua1001@outlook.com"

        # Two verifies with two different arbitrary codes.
        r1 = client.post(
            "/auth/verify-code",
            json={"email": email, "code": "111111"},
        )
        assert r1.status_code == 200, r1.text

        r2 = client.post(
            "/auth/verify-code",
            json={"email": email, "code": "222222"},
        )
        assert r2.status_code == 200, r2.text

        # Two distinct bypass rows.
        rows = db.query(VerificationCode).filter_by(email=email).all()
        assert len(rows) == 2
        assert all(r.used for r in rows)
        assert all(r.code == "000000" for r in rows)


class TestNonBypassRegression:
    """Non-bypass emails must still flow through the real SMTP path."""

    def test_non_bypass_send_code_invokes_email_service(
        self, client: TestClient, db
    ) -> None:
        """send-code on a non-bypass email must call EmailService."""
        email = "newuser-not-bypass@example.com"

        with patch("app.api.auth.EmailService") as mock_cls:
            instance: Any = mock_cls.return_value
            # AsyncMock so the `await service.send_verification_code(...)`
            # call inside the endpoint works under TestClient.
            instance.send_verification_code = AsyncMock(return_value=None)

            r = client.post("/auth/send-code", json={"email": email})
            assert r.status_code == 200, r.text
            # EmailService WAS instantiated (real SMTP path).
            mock_cls.assert_called_once()
            # The async SMTP coroutine was awaited once.
            instance.send_verification_code.assert_awaited_once()

        # A real verification_codes row was written for this email.
        rows = db.query(VerificationCode).filter_by(email=email).all()
        assert len(rows) == 1
        assert rows[0].used is False
        assert rows[0].code != "000000"  # real 6-digit code

    def test_non_bypass_verify_with_wrong_code_returns_401(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        """Without the real code, verify must 401 — bypass does not apply."""
        email = "newuser-not-bypass@example.com"

        # Send a real code (mocked SMTP — no network).
        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 200, r.text

        # Submit a wrong code; bypass does NOT apply, so we get 401.
        r = client.post(
            "/auth/verify-code",
            json={"email": email, "code": "000000"},
        )
        assert r.status_code == 401, r.text
        assert r.json().get("detail", {}).get("error") == "invalid or expired code"

    def test_non_bypass_email_not_in_bypass_set(self):
        """Defence in depth: the non-bypass email must NOT be a member."""
        assert "newuser-not-bypass@example.com" not in DEV_BYPASS_EMAILS