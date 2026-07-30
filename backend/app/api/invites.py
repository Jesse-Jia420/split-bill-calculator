"""Invites API — Sprint 1 T09 + v0.1.1 redesign.

v0.1.1 redesign (2026-06-30)
----------------------------
OLD: each session could have N invite links, each row in session_invites.
Owner minted new rows (POST) and revoked individual rows (DELETE).

NEW: each session has exactly ONE invite token stored as a column on the
sessions table. 30-day TTL, rotatable by the owner. The token becomes the
session URL: `/invites/{token}`. Same user re-accepting = idempotent
membership lookup (PO decision B ii, "accepted still works").

Endpoints
---------
GET    /sessions/{id}/invite          Member reads the current token + status
POST   /sessions/{id}/invite/rotate   Owner rotates the token (new 32-byte secret
                                      + 30-day TTL)
GET    /invites/{token}                Public preview (no auth)
POST   /invites/{token}/accept         Authenticated join (idempotent)

Removed in v0.1.1
-----------------
POST   /sessions/{id}/invites          (replaced by /invite/rotate)
DELETE /sessions/{id}/invites/{iid}    (rotation kills the old token outright)

Auth model
----------
- GET /sessions/{id}/invite — caller must be a session MEMBER (any role).
  Owner needs this to copy the link; non-owners can still see status so the
  page can render "ask the owner for a new link" UX when needed.
- POST /sessions/{id}/invite/rotate — caller must be the session OWNER.
- GET /invites/{token} — public. Returns enough info for the join page
  (session name + inviter nickname + status).
- POST /invites/{token}/accept — requires auth (we bind membership to the
  caller's user_id). Returns 200 with existing membership if the caller is
  already a member (idempotent).

Token + lifecycle
-----------------
- Tokens are 32-byte URL-safe (secrets.token_urlsafe(32)), 256 bits of
  entropy. Stored in clear text on the sessions row -- hashing buys nothing
  because the token itself is the secret (different from auth_tokens, where
  the client receives the raw token and we store sha256 for at-rest safety
  since DB reads may not be the threat model).
- TTL is settings.invite_ttl_days (env INVITE_TTL_DAYS), default 30.
- Rotation: owner calls POST /sessions/{id}/invite/rotate, the old token is
  invalidated immediately (no grace period -- simpler, matches PO spec
  "rotate 之前 disable 旧 token 1 小时" rejection).
- Accept idempotency: same user re-visiting the link = same membership row
  returned. The token does NOT have a "used" state -- the public contract is
  "valid until expiry or rotation".

Errors
------
- 400: invalid token format / blank display_name.
- 401: caller is not logged in (accept + invite/rotate).
- 403: caller is not a member (GET /invite) / not the owner (rotate).
- 404: session not found, or no member row (handled by get_session_member).
- 410: token expired.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member_or_secret, require_session_owner
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User

logger = logging.getLogger(__name__)

router = APIRouter(tags=["invites"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SessionInviteView(BaseModel):
    """Returned by GET /sessions/{id}/invite + POST /sessions/{id}/invite/rotate.

    `url` is the client-relative path (`/invites/{token}`); the frontend
    prepends `window.location.origin` at render time so we don't bake the
    host/port into the API contract (no hardcoded dev port).
    """

    token: str
    url: str
    created_at: str
    expires_at: str
    status: str  # "active" | "expired"


class InvitePublicView(BaseModel):
    """Payload returned by the public GET /invites/{token}.

    Deliberately minimal: the only fields needed to render a join screen.
    No member list, no creator user_id, no internal IDs.
    """

    session_id: int
    session_name: str
    inviter_display_name: str
    status: str  # "active" | "expired"
    expires_at: str


class AcceptInviteRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=50)


class AcceptInviteResponse(BaseModel):
    session_id: int
    role: str
    display_name: str
    joined_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        # SQLite strips tzinfo on roundtrip from DateTime(timezone=True).
        # Production code always inserts tz-aware UTC datetimes, so a
        # naive value still represents UTC — annotate it that way so the
        # serialised ISO string is correct (not offset by local tz).
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _invite_status(session: SessionModel) -> str:
    """Return the public status string for a session's invite token."""
    expires = session.invite_expires_at
    if expires is None:
        return "active"
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        return "expired"
    return "active"


def _invite_payload(session: SessionModel) -> dict:
    """Build the SessionInviteView payload for a session row."""
    return {
        "token": session.invite_token,
        "url": f"/invites/{session.invite_token}",
        "created_at": _iso(session.invite_created_at),
        "expires_at": _iso(session.invite_expires_at),
        "status": _invite_status(session),
    }


# ---------------------------------------------------------------------------
# GET /sessions/{id}/invite   (any session member)
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/invite",
    response_model=SessionInviteView,
)
async def get_session_invite(
    sm: Annotated[SessionMember, Depends(get_session_member_or_secret)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return the current invite token for a session.

    Any member can read this -- the link is meant to be shareable inside
    the session. Non-members 403 via the dependency. Non-owners seeing the
    token is fine: it doesn't grant extra privilege (they could already
    list the session via /sessions).

    200: payload with token + url + created/expires + status.
    401: not logged in.
    403: not a member.
    """
    session = db.query(SessionModel).filter_by(id=sm.session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    return _invite_payload(session)


# ---------------------------------------------------------------------------
# POST /sessions/{id}/invite/rotate   (owner only)
# ---------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/invite/rotate",
    response_model=SessionInviteView,
)
async def rotate_session_invite(
    sm: Annotated[SessionMember, Depends(require_session_owner)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Owner-only: rotate the session's invite token.

    Generates a fresh 32-byte URL-safe token and resets the 30-day TTL.
    The old token is invalidated immediately -- the unique-index collision
    is impossible (full 256-bit entropy) but even if it occurred, the
    first row to commit would win and the rotation would still effectively
    "rotate" because the public preview checks expiry + we update
    invite_created_at so any "previously seen" copies no longer match.

    200: new payload with the fresh token.
    401: not logged in.
    403: caller is not the session owner (checked explicitly so the error
         message is precise -- "only owner can rotate").
    """
    session = db.query(SessionModel).filter_by(id=sm.session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    if sm.role != SessionRole.OWNER.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "only the session owner can rotate the invite"},
        )

    now = datetime.now(timezone.utc)
    session.invite_token = secrets.token_urlsafe(32)
    session.invite_created_at = now
    session.invite_expires_at = now + timedelta(days=settings.invite_ttl_days)
    db.commit()
    db.refresh(session)
    return _invite_payload(session)


# ---------------------------------------------------------------------------
# GET /invites/{token}   (public)
# ---------------------------------------------------------------------------


@router.get(
    "/invites/{token}",
    response_model=InvitePublicView,
)
async def get_invite_public(
    db: Annotated[Session, Depends(get_db)],
    token: str = Path(..., description="Invite token from link"),
) -> dict:
    """Public preview of an invite -- no auth required.

    200: payload returned for an active invite.
    400: invalid token format.
    404: token does not exist (deliberately indistinct from "expired" to
         avoid enumeration).
    410: invite is expired. Body still carries the status field so the UI
         can render "this link has expired" with context.
    """
    if not token or len(token) < 16 or len(token) > 128:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid token format"},
        )

    session = db.query(SessionModel).filter_by(invite_token=token).first()
    if session is None:
        # Deliberately do not distinguish "never existed" from "rotated
        # away" -- both look like 404 to a probing client.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "invite not found"},
        )

    # The inviter is the session owner -- in v0.1.1 the owner is the
    # canonical source of the invite. Prefer the owner's per-session
    # nickname (SessionMember.display_name) so the preview reflects how
    # they sign themselves in this session, not their global default_name.
    owner_member = (
        db.query(SessionMember)
        .filter_by(session_id=session.id, user_id=session.owner_user_id)
        .first()
    )
    if owner_member is not None:
        inviter_display_name = owner_member.display_name
    else:
        owner = db.query(User).filter_by(id=session.owner_user_id).first()
        inviter_display_name = owner.default_name if owner is not None else ""

    status_str = _invite_status(session)
    body = {
        "session_id": session.id,
        "session_name": session.name,
        "inviter_display_name": inviter_display_name,
        "status": status_str,
        "expires_at": _iso(session.invite_expires_at),
    }

    if status_str != "active":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=body,
        )

    return body


# ---------------------------------------------------------------------------
# POST /invites/{token}/accept   (requires auth)
# ---------------------------------------------------------------------------


@router.post(
    "/invites/{token}/accept",
    response_model=AcceptInviteResponse,
)
async def accept_invite(
    payload: AcceptInviteRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    token: str = Path(..., description="Invite token from link"),
) -> dict:
    """Accept an invite; the caller becomes a session member.

    Idempotent: if the caller is already a member of this session, we
    short-circuit and return the existing membership rather than failing.
    This is the v0.1.1 PO contract: "accepted still works" -- a returning
    member can re-visit the link from a new device and still get in.

    200: caller is added (or already a member) of the session.
    400: invalid token format / blank display_name.
    401: caller is not logged in.
    404: token does not exist.
    410: invite has expired.
    """
    if not token or len(token) < 16 or len(token) > 128:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid token format"},
        )

    display_name = payload.display_name.strip()
    if not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "display_name must not be blank"},
        )

    session = db.query(SessionModel).filter_by(invite_token=token).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "invite not found"},
        )

    # Idempotency first: returning member always gets 200 even if the
    # token has been rotated or expired -- once you're in, you're in.
    existing = (
        db.query(SessionMember)
        .filter_by(session_id=session.id, user_id=user.id)
        .first()
    )
    if existing is not None:
        return {
            "session_id": existing.session_id,
            "role": existing.role,
            "display_name": existing.display_name,
            "joined_at": _iso(existing.joined_at),
        }

    # New user: token must still be valid (not expired).
    if _invite_status(session) != "active":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"error": "invite expired"},
        )

    try:
        sm = SessionMember(
            session_id=session.id,
            user_id=user.id,
            display_name=display_name,
            role=SessionRole.MEMBER.value,
        )
        db.add(sm)
        db.commit()
        db.refresh(sm)
    except Exception:
        db.rollback()
        # Race: two simultaneous accepts for the same (session,user).
        # Re-fetch and return the existing row as if it were idempotent.
        existing = (
            db.query(SessionMember)
            .filter_by(session_id=session.id, user_id=user.id)
            .first()
        )
        if existing is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"error": "could not join session"},
            )
        return {
            "session_id": existing.session_id,
            "role": existing.role,
            "display_name": existing.display_name,
            "joined_at": _iso(existing.joined_at),
        }

    return {
        "session_id": sm.session_id,
        "role": sm.role,
        "display_name": sm.display_name,
        "joined_at": _iso(sm.joined_at),
    }
