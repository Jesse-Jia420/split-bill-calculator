"""Auth API router — T06: full auth lifecycle.

Endpoints
---------
POST /auth/send-code
    Request a 6-digit verification code by email.
    Persists the code to ``verification_codes`` (MAGIC_LINK purpose),
    enforces a 5/hour rate limit per email, then sends the email.

POST /auth/verify-code
    Verify the code, auto-register the user on first login, mint a
    long-lived auth token, set the session cookie.

POST /auth/logout
    Invalidate the current auth token (delete row) + clear cookie.

GET /auth/me
    Return the current user (resolved from the session cookie).

Security notes (see SPEC §T06 + antipattern #32):
- We never log raw tokens / codes / passwords.
- We never leak SMTP internals in error responses (5xx details are
  sanitised).
- Cookies are httpOnly + SameSite=Lax + Secure(env-controlled).
- Token storage is sha256(raw); the raw value only travels in the
  Set-Cookie header once at issuance.
"""
from __future__ import annotations

import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import COOKIE_NAME, get_current_user, hash_token
from app.core.config import settings
from app.core.database import get_db
from app.db.models.auth_tokens import AuthToken
from app.db.models.users import User
from app.db.models.verification_codes import (
    VerificationCode,
    VerificationPurpose,
)
from app.services.email_service import (
    EmailAuthError,
    EmailError,
    EmailNetworkError,
    EmailService,
)
from app.services.verification_code import generate_code

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Defensive local regex — keep 400 vs 422 response shapes distinct.
_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
_CODE_RE = re.compile(r"^\d{6}$")

_RATELIMIT_WINDOW_HOURS = 1

# ---------------------------------------------------------------------------
# Dev bypass (v0.1.4)
# ---------------------------------------------------------------------------
# Emails listed in the ``DEV_BYPASS_EMAILS`` env var (CSV, lower-cased on
# load) skip the SMTP send + the real verification_code lookup. They
# are a developer affordance for browser-based screenshot/QA flows that
# cannot read a real inbox. In production the env var is unset so this
# set is empty and the bypass is a no-op. See SPEC.md antipattern #48 +
# v0.1.4 decision (option B: full bypass).
DEV_BYPASS_EMAILS: set[str] = {
    e.strip().lower()
    for e in os.getenv("DEV_BYPASS_EMAILS", "").split(",")
    if e.strip()
}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SendCodeRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


class SendCodeResponse(BaseModel):
    sent: bool
    email: str
    ttl_minutes: int


class VerifyCodeRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    code: str = Field(..., min_length=6, max_length=6)


class VerifyCodeResponse(BaseModel):
    user_id: int
    email: str
    default_name: str
    auth_token_expires_at: str


class LogoutResponse(BaseModel):
    logged_out: bool


class MeResponse(BaseModel):
    user_id: int
    email: str
    default_name: str


# ---------------------------------------------------------------------------
# POST /auth/send-code
# ---------------------------------------------------------------------------


@router.post("/send-code", response_model=SendCodeResponse)
async def send_verification_code(
    payload: SendCodeRequest,
    db: Annotated[Session, Depends(get_db)],
) -> SendCodeResponse:
    """Send a 6-digit verification code, persisted to DB.

    200: code sent
    400: invalid email format
    422: missing field (pydantic)
    429: rate limit exceeded (5/hour per email)
    500: SMTP / DB failure
    """
    email = payload.email.strip()

    if not _EMAIL_RE.match(email) or len(email) > 320:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid email format"},
        )

    # Dev bypass: skip rate-limit + SMTP + DB write. The client gets the
    # same response shape as the normal flow so the FE never knows.
    if email.lower() in DEV_BYPASS_EMAILS:
        logger.info(
            "dev bypass send-code email=%s (no email sent, no row written)",
            email,
        )
        return SendCodeResponse(
            sent=True,
            email=email,
            ttl_minutes=settings.verification_code_ttl_minutes,
        )

    # Rate limit: count MAGIC_LINK codes created for this email in the
    # last hour. If we've already hit the cap, refuse and tell the
    # caller when they can retry.
    window_start = datetime.now(timezone.utc) - timedelta(hours=_RATELIMIT_WINDOW_HOURS)
    recent = (
        db.query(func.count(VerificationCode.id))
        .filter(
            VerificationCode.email == email,
            VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
            VerificationCode.created_at >= window_start,
        )
        .scalar()
    )
    if recent >= settings.send_code_rate_limit_per_hour:
        # Calculate retry_after from the oldest row in the window.
        oldest = (
            db.query(VerificationCode.created_at)
            .filter(
                VerificationCode.email == email,
                VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
                VerificationCode.created_at >= window_start,
            )
            .order_by(VerificationCode.created_at.asc())
            .first()
        )
        if oldest is not None:
            oldest_ts = oldest[0]
            if oldest_ts.tzinfo is None:
                oldest_ts = oldest_ts.replace(tzinfo=timezone.utc)
            retry_after_minutes = max(
                1,
                int(
                    (
                        oldest_ts
                        + timedelta(hours=_RATELIMIT_WINDOW_HOURS)
                        - datetime.now(timezone.utc)
                    ).total_seconds()
                    / 60
                )
                + 1,
            )
        else:
            retry_after_minutes = 60
        raise HTTPException(
            status_code=429,
            detail={
                "error": "rate limit exceeded",
                "retry_after_minutes": retry_after_minutes,
            },
        )

    # Garbage-collect: drop unused codes that are older than the rate-
    # limit window so the rate-limit count remains accurate. Within the
    # window we keep rows even if unused (they double as rate-limit
    # history; deleting them would let the user bypass the cap).
    now = datetime.now(timezone.utc)
    (
        db.query(VerificationCode)
        .filter(
            VerificationCode.email == email,
            VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
            VerificationCode.used.is_(False),
            VerificationCode.created_at < (now - timedelta(hours=_RATELIMIT_WINDOW_HOURS)),
        )
        .delete(synchronize_session=False)
    )

    # Mint + persist a new code.
    code = generate_code()
    expires_at = now + timedelta(minutes=settings.verification_code_ttl_minutes)
    row = VerificationCode(
        email=email,
        code=code,
        purpose=VerificationPurpose.MAGIC_LINK.value,
        session_id=None,
        expires_at=expires_at,
        used=False,
    )
    db.add(row)
    db.commit()

    # Send the email. If SMTP fails, we still keep the row — but we
    # surface a 500 so the client can retry. We never leak SMTP internals.
    service = EmailService(settings)
    try:
        await service.send_verification_code(
            email, code, settings.verification_code_ttl_minutes
        )
    except (EmailAuthError, EmailNetworkError, EmailError):
        logger.error("send-code: email dispatch failed for %s", email)
        raise HTTPException(
            status_code=500,
            detail={"error": "send failed"},
        )

    return SendCodeResponse(
        sent=True,
        email=email,
        ttl_minutes=settings.verification_code_ttl_minutes,
    )


# ---------------------------------------------------------------------------
# POST /auth/verify-code
# ---------------------------------------------------------------------------


@router.post("/verify-code", response_model=VerifyCodeResponse)
async def verify_code(
    payload: VerifyCodeRequest,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> VerifyCodeResponse:
    """Verify a code, auto-register the user if new, issue a token.

    200: verified — body has user fields, Set-Cookie carries the token.
    400: invalid email or code format.
    401: code mismatch / used / expired / not found.
    500: DB failure.
    """
    email = payload.email.strip()
    code = payload.code.strip()

    if not _EMAIL_RE.match(email) or len(email) > 320:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid email format"},
        )
    if not _CODE_RE.match(code):
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid code format"},
        )

    now = datetime.now(timezone.utc)
    is_bypass = email.lower() in DEV_BYPASS_EMAILS

    if is_bypass:
        # Dev bypass: accept ANY 6-digit code. We still write a row to
        # ``verification_codes`` (code="000000", used=True) so an audit
        # trail exists. The row is created used=True so the rate-limit
        # GC leaves it alone (used rows aren't eligible) and so the row
        # cannot be replayed.
        bypass_code = VerificationCode(
            email=email,
            code="000000",
            purpose=VerificationPurpose.MAGIC_LINK.value,
            session_id=None,
            expires_at=now + timedelta(hours=24),
            used=True,
        )
        db.add(bypass_code)
        db.flush()
        candidate = bypass_code
        logger.info(
            "dev bypass verify-code email=%s (any code accepted)",
            email,
        )
    else:
        # Look up the latest unused, unexpired MAGIC_LINK code for this email.
        candidate = (
            db.query(VerificationCode)
            .filter(
                VerificationCode.email == email,
                VerificationCode.purpose == VerificationPurpose.MAGIC_LINK.value,
                VerificationCode.used.is_(False),
                VerificationCode.expires_at > now,
            )
            .order_by(VerificationCode.created_at.desc())
            .first()
        )
        if candidate is None:
            raise HTTPException(
                status_code=401,
                detail={"error": "invalid or expired code"},
            )

        # Compare with constant-time equality to defeat timing oracles.
        # Both sides must be bytes of the same length; codes are fixed 6-digit
        # strings so this is fine.
        stored = candidate.code.encode("utf-8")
        submitted = code.encode("utf-8")
        if not hmac.compare_digest(stored, submitted):
            raise HTTPException(
                status_code=401,
                detail={"error": "invalid or expired code"},
            )

        # Mark the code consumed (single-use). Bypass rows are already
        # used=True at insert time, so this is a no-op for them.
        candidate.used = True
        db.flush()

    # Find or auto-create the User. Lightweight identity model: the
    # first time we see an email, we mint a User with default_name =
    # local-part of the email (capped at 120 chars to fit the column).
    user = db.query(User).filter_by(email=email).first()
    if user is None:
        local_part = email.split("@", 1)[0][:120]
        user = User(email=email, default_name=local_part)
        db.add(user)
        db.flush()
        db.refresh(user)

    # Mint a new auth token. Raw token goes only into the Set-Cookie
    # header; DB stores sha256(raw).
    raw_token = secrets.token_urlsafe(32)
    token_hash_value = hash_token(raw_token)
    expires_at = now + timedelta(days=settings.auth_token_ttl_days)
    auth_token = AuthToken(
        user_id=user.id,
        token_hash=token_hash_value,
        expires_at=expires_at,
        last_used_at=None,
    )
    db.add(auth_token)
    db.commit()
    db.refresh(user)

    # Set the session cookie.
    response.set_cookie(
        key=COOKIE_NAME,
        value=raw_token,
        max_age=settings.auth_token_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )

    return VerifyCodeResponse(
        user_id=user.id,
        email=user.email,
        default_name=user.default_name,
        auth_token_expires_at=expires_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


@router.post("/logout", response_model=LogoutResponse)
async def logout(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    sbc_session: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> LogoutResponse:
    """Invalidate the current token (DB delete) + clear the cookie.

    Always returns 200: a missing/invalid cookie is *not* an error
    condition from the client's point of view — we just make sure the
    browser cookie is gone. This also avoids leaking session state.
    """
    if sbc_session:
        token_hash_value = hash_token(sbc_session)
        (
            db.query(AuthToken)
            .filter(AuthToken.token_hash == token_hash_value)
            .delete(synchronize_session=False)
        )
        db.commit()

    response.delete_cookie(COOKIE_NAME, path="/")
    return LogoutResponse(logged_out=True)


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------


@router.get("/me", response_model=MeResponse)
async def me(
    current_user: Annotated[User, Depends(get_current_user)],
) -> MeResponse:
    """Return the current user, or 401 if not authenticated."""
    return MeResponse(
        user_id=current_user.id,
        email=current_user.email,
        default_name=current_user.default_name,
    )