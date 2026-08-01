"""Email service — sends verification codes via Aliyun DirectMail SMTP.

Reads SMTP credentials from settings and dispatches emails on demand.
Errors are translated into a small, typed exception hierarchy so the
caller (the /auth/send-code endpoint) can map them to HTTP status codes.

Security:
- Never logs `smtp_password` (only host + user + status).
- SMTP is connected lazily — not at import or construction time.
"""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.core.config import Settings

logger = logging.getLogger(__name__)


class EmailError(Exception):
    """Base class for all email-service errors."""


class EmailAuthError(EmailError):
    """SMTP authentication failed (bad username/password, account locked, etc.)."""


class EmailNetworkError(EmailError):
    """Network-level failure connecting to or talking to the SMTP server."""


# Subject prefixes & footer text used in the verification-code template.
_SUBJECT_PREFIX = "[轻均分账 FairLite] 您的验证码"
_FROM_NAME = "轻均分账 FairLite"


class EmailService:
    """Send transactional email (verification codes) via Aliyun DirectMail SMTP."""

    def __init__(self, settings: "Settings") -> None:
        # Cache config so we don't reach into `settings` on every send.
        self._smtp_host: str = settings.smtp_host
        self._smtp_port: int = settings.smtp_port
        self._smtp_username: str = settings.smtp_username
        self._smtp_password: str = settings.smtp_password
        self._from_addr: str = settings.smtp_from
        self._use_tls: bool = settings.smtp_use_tls
        self._use_ssl: bool = settings.smtp_use_ssl

    async def send_verification_code(
        self,
        to_email: str,
        code: str,
        ttl_minutes: int,
    ) -> None:
        """Send a 6-digit verification code to ``to_email``.

        ``ttl_minutes`` is the lifetime of the code (used in the email body).
        """
        msg = self._build_message(to_email, code, ttl_minutes)
        try:
            self._connect_and_send(msg)
        except smtplib.SMTPAuthenticationError as exc:
            # Do NOT include password in the message we re-raise.
            logger.error(
                "SMTP auth failed (host=%s, user=%s): %s",
                self._smtp_host,
                self._smtp_username,
                exc.smtp_code,
            )
            raise EmailAuthError(
                f"SMTP authentication failed (code={exc.smtp_code})"
            ) from exc
        except (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected, OSError) as exc:
            logger.error(
                "SMTP network error (host=%s, port=%s): %s",
                self._smtp_host,
                self._smtp_port,
                exc.__class__.__name__,
            )
            raise EmailNetworkError(
                f"SMTP network error: {exc.__class__.__name__}"
            ) from exc
        except smtplib.SMTPException as exc:
            logger.error(
                "SMTP error (host=%s, user=%s): %s",
                self._smtp_host,
                self._smtp_username,
                exc.__class__.__name__,
            )
            raise EmailError(
                f"SMTP error: {exc.__class__.__name__}"
            ) from exc

        logger.info(
            "Sent verification code to %s via %s (ttl=%dm)",
            to_email,
            self._smtp_host,
            ttl_minutes,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _build_message(
        self,
        to_email: str,
        code: str,
        ttl_minutes: int,
    ) -> MIMEMultipart:
        """Construct the multipart email with plain-text + simple HTML."""
        subject = f"{_SUBJECT_PREFIX}: {code}"
        plain = (
            f"您的 轻均分账 FairLite 验证码是：{code}\n\n"
            f"此验证码将在 {ttl_minutes} 分钟后过期。\n"
            "如果您没有请求此验证码，可以直接忽略此邮件。\n"
        )
        html = (
            f"<p>您的 <strong>轻均分账 FairLite</strong> 验证码是："
            f" <strong style='font-size:18px;letter-spacing:2px'>{code}</strong></p>"
            f"<p>此验证码将在 {ttl_minutes} 分钟后过期。</p>"
            "<p style='color:#888;font-size:12px'>If you did not request this code, "
            "you can safely ignore this email.</p>"
        )

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{_FROM_NAME} <{self._from_addr}>"
        msg["To"] = to_email
        msg.attach(MIMEText(plain, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
        return msg

    def _connect_and_send(self, msg: MIMEMultipart) -> None:
        """Open an SMTP connection, authenticate, and send ``msg``.

        Two connection modes are supported:
        - **SMTP_SSL** (implicit TLS from connect): used when
          ``smtp_use_ssl=True``. This is the port-465 pattern (e.g. Aliyun
          DirectMail ``smtpdm.aliyun.com:465``).
        - **SMTP + STARTTLS** (opportunistic TLS): legacy Gmail pattern
          (smtp.gmail.com:587). Used when ``smtp_use_ssl=False`` and
          ``smtp_use_tls=True``.
        """
        if self._use_ssl:
            # Implicit SSL -- handshake happens at connect time. STARTTLS is
            # not used (and would be a protocol error on a SSL-wrapped socket).
            with smtplib.SMTP_SSL(
                self._smtp_host, self._smtp_port, timeout=15
            ) as client:
                client.login(self._smtp_username, self._smtp_password)
                client.send_message(msg)
            return
        with smtplib.SMTP(self._smtp_host, self._smtp_port, timeout=15) as client:
            if self._use_tls:
                client.starttls()
            client.login(self._smtp_username, self._smtp_password)
            client.send_message(msg)


def build_plain_text_message(
    to_email: str,
    from_addr: str,
    subject: str,
    body: str,
) -> EmailMessage:
    """Helper for tests / non-verification emails.

    Kept here (rather than in a separate module) because it's only used
    by the verification-code path right now. If we grow more email types
    in v0.2 we should split this out.
    """
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_email
    msg.set_content(body)
    return msg
