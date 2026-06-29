"""Unit tests for EmailService + the /auth/send-code endpoint.

SMTP is mocked in these tests — the real round-trip is covered by the
end-to-end ``python -m scripts.verify_email`` run during Coder QA.
"""
from __future__ import annotations

import logging
import smtplib
from email import message_from_string
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import app
from app.services.email_service import (
    EmailAuthError,
    EmailError,
    EmailNetworkError,
    EmailService,
)


# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def settings() -> Settings:
    """A Settings instance with SMTP values that won't be sent to a real
    server (we mock smtplib in every test that uses EmailService)."""
    return Settings(
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_username="test@example.com",
        smtp_password="secret-app-password",  # noqa: S105 (test-only)
        smtp_from="test@example.com",
        smtp_use_tls=True,
    )


@pytest.fixture
def client() -> TestClient:
    """FastAPI TestClient. We override the EmailService via monkeypatch
    in the endpoint tests; this just wires the app."""
    return TestClient(app)


# ---------------------------------------------------------------------------
# EmailService
# ---------------------------------------------------------------------------


class TestEmailService:
    def test_send_verification_code_uses_starttls_login_send(
        self, settings: Settings, caplog: pytest.LogCaptureFixture
    ) -> None:
        service = EmailService(settings)
        mock_smtp = MagicMock(spec=smtplib.SMTP)
        mock_smtp.__enter__.return_value = mock_smtp
        mock_smtp.__exit__.return_value = False

        with patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp):
            with caplog.at_level(logging.INFO):
                # The method is async but does no real await — fine to drive
                # it directly for unit-test purposes.
                import asyncio

                asyncio.run(service.send_verification_code("x@y.com", "123456", 10))

        mock_smtp.starttls.assert_called_once()
        mock_smtp.login.assert_called_once_with("test@example.com", "secret-app-password")
        mock_smtp.send_message.assert_called_once()

    def test_message_contains_expected_headers_and_code(
        self, settings: Settings
    ) -> None:
        service = EmailService(settings)
        msg = service._build_message("jesse@jia.click", "482915", 10)  # noqa: SLF001
        assert msg["Subject"].endswith("482915")
        assert "jesse@jia.click" in (msg["To"] or "")
        assert "test@example.com" in (msg["From"] or "")
        # Both plain and html payloads attached.
        payloads = [p.get_payload(decode=True).decode("utf-8") for p in msg.walk()
                    if p.get_content_type() in ("text/plain", "text/html")]
        assert any("482915" in p for p in payloads)
        assert any("10" in p for p in payloads)  # ttl_minutes

    def test_smtp_auth_error_translates_to_EmailAuthError(
        self, settings: Settings
    ) -> None:
        service = EmailService(settings)
        mock_smtp = MagicMock(spec=smtplib.SMTP)
        mock_smtp.__enter__.return_value = mock_smtp
        mock_smtp.__exit__.return_value = False
        mock_smtp.login.side_effect = smtplib.SMTPAuthenticationError(
            535, b"Auth failed"
        )

        with patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp):
            import asyncio

            with pytest.raises(EmailAuthError):
                asyncio.run(service.send_verification_code("x@y.com", "123456", 10))

    def test_smtp_connect_error_translates_to_EmailNetworkError(
        self, settings: Settings
    ) -> None:
        service = EmailService(settings)
        mock_smtp = MagicMock(spec=smtplib.SMTP)
        mock_smtp.__enter__.return_value = mock_smtp
        mock_smtp.__exit__.return_value = False
        mock_smtp.starttls.side_effect = smtplib.SMTPConnectError(421, b"try again")

        with patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp):
            import asyncio

            with pytest.raises(EmailNetworkError):
                asyncio.run(service.send_verification_code("x@y.com", "123456", 10))

    def test_password_is_not_logged_on_auth_failure(
        self, settings: Settings, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The smtp_password value must not appear in any log line — even
        on the failure path."""
        service = EmailService(settings)
        mock_smtp = MagicMock(spec=smtplib.SMTP)
        mock_smtp.__enter__.return_value = mock_smtp
        mock_smtp.__exit__.return_value = False
        mock_smtp.login.side_effect = smtplib.SMTPAuthenticationError(
            535, b"Auth failed"
        )

        with patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp):
            import asyncio

            with caplog.at_level(logging.ERROR):
                with pytest.raises(EmailAuthError):
                    asyncio.run(service.send_verification_code("x@y.com", "123456", 10))

        for record in caplog.records:
            assert "secret-app-password" not in record.getMessage()

    def test_password_is_not_logged_on_success(
        self, settings: Settings, caplog: pytest.LogCaptureFixture
    ) -> None:
        service = EmailService(settings)
        mock_smtp = MagicMock(spec=smtplib.SMTP)
        mock_smtp.__enter__.return_value = mock_smtp
        mock_smtp.__exit__.return_value = False

        with patch("app.services.email_service.smtplib.SMTP", return_value=mock_smtp):
            import asyncio

            with caplog.at_level(logging.INFO):
                asyncio.run(service.send_verification_code("x@y.com", "123456", 10))

        for record in caplog.records:
            assert "secret-app-password" not in record.getMessage()


# ---------------------------------------------------------------------------
# /auth/send-code endpoint
# ---------------------------------------------------------------------------


class TestSendCodeEndpoint:
    def test_valid_email_returns_200_with_sent_true(
        self, client: TestClient
    ) -> None:
        with patch("app.api.auth.EmailService") as mock_cls:
            instance: Any = mock_cls.return_value
            import asyncio

            async def _noop_send(*_args: Any, **_kwargs: Any) -> None:
                return None

            instance.send_verification_code.side_effect = _noop_send

            response = client.post(
                "/auth/send-code",
                json={"email": "jessejia1001@gmail.com"},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["sent"] is True
        assert body["email"] == "jessejia1001@gmail.com"
        assert body["ttl_minutes"] >= 1

    def test_invalid_email_returns_400(self, client: TestClient) -> None:
        # The endpoint validates email format with a regex (NOT pydantic
        # EmailStr) so it can return a clean 400 with the documented
        # {detail: {error: ...}} shape, not pydantic's default 422.
        response = client.post(
            "/auth/send-code",
            json={"email": "not-an-email"},
        )
        assert response.status_code == 400
        body = response.json()
        # The detail is { "error": "invalid email format" }
        detail = body.get("detail")
        if isinstance(detail, dict):
            assert "invalid email" in detail.get("error", "").lower()
        else:
            # FastAPI may flatten the dict in odd ways; just be lenient.
            assert "invalid email" in str(detail).lower()

    def test_smtp_error_returns_500(self, client: TestClient) -> None:
        with patch("app.api.auth.EmailService") as mock_cls:
            instance: Any = mock_cls.return_value
            import asyncio

            async def _boom(*_args: Any, **_kwargs: Any) -> None:
                raise EmailAuthError("auth boom")

            instance.send_verification_code.side_effect = _boom

            response = client.post(
                "/auth/send-code",
                json={"email": "jessejia1001@gmail.com"},
            )

        assert response.status_code == 500
        body = response.json()
        # The detail shape is { "error": "..." } on the 500 path.
        assert "send failed" in (body.get("detail", {}).get("error", "")
                                  if isinstance(body.get("detail"), dict)
                                  else str(body.get("detail", "")))


# Sanity: ensure message_from_string doesn't blow up on what we emit.
def test_built_message_is_valid_mime(settings: Settings) -> None:
    service = EmailService(settings)
    msg = service._build_message("x@y.com", "000000", 5)  # noqa: SLF001
    raw = msg.as_string()
    parsed = message_from_string(raw)
    assert parsed["Subject"]
    assert parsed["From"]
    assert parsed["To"] == "x@y.com"
