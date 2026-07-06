"""FastAPI dependency: extract authenticated user from the session cookie.

The cookie carries the **raw** auth token (43-char URL-safe base64).
We never store the raw token on the server — only sha256(raw_token)
goes into auth_tokens.token_hash. So the cookie value IS the
credential; treat it accordingly.

v0.1 design notes (Sprint 1 T06):
- httpOnly cookie (XSS mitigation).
- SameSite=Lax (CSRF mitigation).
- Token TTL = 30 days (settings.auth_token_ttl_days).
- Multi-device allowed (no rotation on each login); old tokens survive
  until their own expires_at.
- We **do not** update last_used_at on every request (TTL is the
  source of truth for validity). v0.2 may add a periodic refresh.

See SPEC.md §8 / antipattern #32 for the full design rationale.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from fastapi import Cookie, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.db.models.auth_tokens import AuthToken
from app.db.models.users import User


def hash_token(raw_token: str) -> str:
    """SHA-256 hex digest of the raw auth token. Used as DB lookup key."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    sbc_session: str | None = Cookie(default=None),
) -> User:
    """FastAPI dependency that resolves the current logged-in user from cookie.

    Raises 401 if the cookie is missing, the token is unknown, or it has
    expired. Otherwise returns the User ORM instance and stashes it
    on request.state.user for any middleware / logging downstream.
    """
    if not sbc_session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "not authenticated"},
        )

    token_hash = hash_token(sbc_session)
    auth = db.query(AuthToken).filter_by(token_hash=token_hash).first()
    if auth is None:
        # Token not in DB (logout, forged, or from a previous install).
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "invalid or expired token"},
        )

    now = datetime.now(timezone.utc)
    expires_at = auth.expires_at
    # SQLite can return naive datetimes depending on driver version — normalise.
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at is not None and expires_at < now:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "invalid or expired token"},
        )

    user: User = auth.user
    # Stash for middleware / logging — does not affect the response.
    request.state.user = user
    return user


def get_optional_user(
    request: Request,
    db: Session = Depends(get_db),
    sbc_session: str | None = Cookie(default=None),
) -> User | None:
    """FastAPI dependency that returns the logged-in user or None (no 401).

    Use this for endpoints that support both anonymous and authenticated callers.
    """
    if not sbc_session:
        return None

    token_hash = hash_token(sbc_session)
    auth = db.query(AuthToken).filter_by(token_hash=token_hash).first()
    if auth is None:
        return None

    now = datetime.now(timezone.utc)
    expires_at = auth.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at is not None and expires_at < now:
        return None

    user: User = auth.user
    request.state.user = user
    return user


# Cookie name is centralised in settings; this re-export lets call sites
# from app.core.auth import COOKIE_NAME if they need it without importing
# settings directly.
COOKIE_NAME = settings.session_cookie_name
