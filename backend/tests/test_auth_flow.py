"""End-to-end auth flow tests — exercise the live FastAPI app via TestClient.

These tests cover the full happy-path lifecycle:

    POST /auth/send-code
        -> POST /auth/verify-code (sets cookie)
        -> GET  /auth/me         (cookie resolves to user)
        -> POST /auth/logout     (deletes cookie + DB token)
        -> GET  /auth/me         (now 401)

Plus a few failure-mode smokes (no cookie, cookie after logout).

SMTP is mocked; verification codes are read back from the DB so the
test does not depend on the email content.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.auth import COOKIE_NAME, hash_token
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
    """Reset tables between tests."""
    import os as _os
    if _os.environ.get("SBC_SKIP_TEST_TRUNCATE") == "1":
        yield
        return

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
def mock_email_service():
    with patch("app.api.auth.EmailService") as mock_cls:
        instance: Any = mock_cls.return_value

        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        instance.send_verification_code.side_effect = _noop
        yield mock_cls


def _latest_unused_code(email: str) -> str:
    db = SessionLocal()
    try:
        row = (
            db.query(VerificationCode)
            .filter(
                VerificationCode.email == email,
                VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
                VerificationCode.used.is_(False),
            )
            .order_by(VerificationCode.created_at.desc())
            .first()
        )
        assert row is not None, f"no unused code for {email}"
        return row.code
    finally:
        db.close()


def _token_hashes_for(email: str) -> list[str]:
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(email=email).first()
        if user is None:
            return []
        return [t.token_hash for t in user.auth_tokens]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# End-to-end happy path
# ---------------------------------------------------------------------------


class TestLoginFlowInBrowser:
    """Exercise the full lifecycle as if driven by a real browser."""

    def test_full_login_lifecycle(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        email = "jesse@example.com"

        # 1. Request a verification code.
        r = client.post("/auth/send-code", json={"email": email})
        assert r.status_code == 200, r.text
        assert r.json() == {
            "sent": True,
            "email": email,
            "ttl_minutes": 10,
        }

        # 2. Verify the code (simulating the user typing it in).
        code = _latest_unused_code(email)
        r = client.post("/auth/verify-code", json={"email": email, "code": code})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == email
        assert body["default_name"] == "jesse"
        assert isinstance(body["user_id"], int)
        assert "auth_token_expires_at" in body

        # The Set-Cookie header carries the session cookie.
        set_cookie = r.headers.get("set-cookie", "")
        assert COOKIE_NAME in set_cookie
        assert "HttpOnly" in set_cookie
        assert "SameSite=Lax" in set_cookie or "samesite=lax" in set_cookie.lower()
        assert "Path=/" in set_cookie

        # 3. /auth/me with the cookie returns the user.
        cookies = {COOKIE_NAME: client.cookies.get(COOKIE_NAME)}
        assert cookies[COOKIE_NAME], "cookie should have been set"
        r = client.get("/auth/me", cookies=cookies)
        assert r.status_code == 200, r.text
        me = r.json()
        assert me["email"] == email
        assert me["user_id"] == body["user_id"]

        # 4. /auth/me WITHOUT the cookie is 401 (use a brand-new client
        # so it does not inherit the verified session).
        anon = TestClient(app)
        r = anon.get("/auth/me")
        assert r.status_code == 401, r.text

        # 5. Logout deletes the token + clears the cookie.
        r = client.post("/auth/logout", cookies=cookies)
        assert r.status_code == 200, r.text
        assert r.json() == {"logged_out": True}
        # Set-Cookie should expire the cookie.
        sc = r.headers.get("set-cookie", "")
        assert COOKIE_NAME in sc
        assert "Max-Age=0" in sc or "max-age=0" in sc.lower()

        # DB token row deleted.
        assert _token_hashes_for(email) == []

        # 6. /auth/me with the OLD cookie is now 401.
        r = client.get("/auth/me", cookies=cookies)
        assert r.status_code == 401, r.text

    def test_multi_device_login_via_two_clients(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        """Two browsers (two TestClient instances) log in as the same email.

        Both cookies should remain valid simultaneously (F2: multi-device
        coexist).
        """
        email = "shared@example.com"
        browser_a = TestClient(app)
        browser_b = TestClient(app)

        # Browser A: send + verify.
        browser_a.post("/auth/send-code", json={"email": email})
        code_a = _latest_unused_code(email)
        r = browser_a.post("/auth/verify-code", json={"email": email, "code": code_a})
        assert r.status_code == 200
        cookie_a = browser_a.cookies.get(COOKIE_NAME)

        # Browser B: send + verify (second send triggers a new code).
        browser_b.post("/auth/send-code", json={"email": email})
        code_b = _latest_unused_code(email)
        r = browser_b.post("/auth/verify-code", json={"email": email, "code": code_b})
        assert r.status_code == 200
        cookie_b = browser_b.cookies.get(COOKIE_NAME)

        assert cookie_a != cookie_b, "fresh token per login"

        # Both cookies resolve to the same user.
        r1 = browser_a.get("/auth/me", cookies={COOKIE_NAME: cookie_a})
        r2 = browser_b.get("/auth/me", cookies={COOKIE_NAME: cookie_b})
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["user_id"] == r2.json()["user_id"]

        # Two distinct token rows in the DB.
        assert len(_token_hashes_for(email)) == 2
        assert hash_token(cookie_a) in _token_hashes_for(email)
        assert hash_token(cookie_b) in _token_hashes_for(email)

        # Browser A logs out; Browser B's session is unaffected.
        r = browser_a.post("/auth/logout", cookies={COOKIE_NAME: cookie_a})
        assert r.status_code == 200

        r_a = browser_a.get("/auth/me", cookies={COOKIE_NAME: cookie_a})
        r_b = browser_b.get("/auth/me", cookies={COOKIE_NAME: cookie_b})
        assert r_a.status_code == 401
        assert r_b.status_code == 200

    def test_invalid_email_format_returns_400(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        r = client.post("/auth/send-code", json={"email": "not-an-email"})
        assert r.status_code == 400
        assert r.json().get("detail", {}).get("error") == "invalid email format"

    def test_missing_field_returns_422(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        r = client.post("/auth/send-code", json={})
        assert r.status_code == 422

    def test_wrong_code_does_not_consume_unrelated_codes(
        self, client: TestClient, mock_email_service: Any
    ) -> None:
        """Submitting a wrong code must NOT mark the real one used.

        A wrong-code attempt is rejected before any state change.
        """
        email = "wrong@example.com"
        client.post("/auth/send-code", json={"email": email})
        real_code = _latest_unused_code(email)
        assert real_code != "000000"

        r = client.post(
            "/auth/verify-code",
            json={"email": email, "code": "000000"},
        )
        assert r.status_code == 401

        # Real code should still be unused and accepted.
        r = client.post(
            "/auth/verify-code",
            json={"email": email, "code": real_code},
        )
        assert r.status_code == 200
