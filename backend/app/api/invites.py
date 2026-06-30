"""Invites API — Sprint 1 T09.

Endpoints (mounted under /invites + /sessions/{id}/invites):

POST   /sessions/{session_id}/invites              Mint a fresh invite
DELETE /sessions/{session_id}/invites/{invite_id}  Revoke (owner-only)
GET    /invites/{token}                            Public invite preview
POST   /invites/{token}/accept                     Accept + add as member

Auth model
----------
- POST /sessions/{id}/invites — caller must be a session MEMBER
  (any role). The link is for inviting teammates; both owner and
  member can hand one out.
- DELETE /sessions/{id}/invites/{iid} — caller must be the session
  OWNER. v0.1 simplification: only the owner can revoke.
- GET /invites/{token} — public; returns enough info for the join
  page (session name + inviter nickname + status) but no internal
  IDs of other members or anything sensitive.
- POST /invites/{token}/accept — public route, but the caller MUST
  already be authenticated (we bind the invite to *their* user_id).
  If they're not logged in, the standard 401 fires.

Token + lifecycle
-----------------
- Tokens are 32-byte URL-safe (secrets.token_urlsafe(32)).
- TTL is settings.invite_ttl_days (env INVITE_TTL_DAYS),
  default 30.
- We persist the SHA-style token in clear text (it's already a
  random 256-bit value; hashing buys us nothing extra here — the
  existing auth_token pattern is keyed by an external secret, this
  isn't). v0.1 keeps the column unique so lookups are O(1).
- Accept marks used_at + accepted_by_user_id; the row stays
  in the table (cheap audit trail) but is treated as "accepted" by
  subsequent GETs / accepts.
- DELETE is a soft delete (deleted_at = now). Already-accepted
  invites return 404 — the contract is "you can't revoke a used
  invite".

Errors
------
- 400: invalid token format / bad display_name.
- 401: caller is not logged in (accept).
- 403: caller is not a member (create) / not the owner (revoke).
- 404: invite not found / already revoked / already accepted (revoke
  only — GET/accept use 410 for non-active states).
- 410: invite exists but is in a non-active state (accepted /
  expired / deleted).
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member, require_session_owner
from app.db.models.session_invites import SessionInvite
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User

logger = logging.getLogger(__name__)

router = APIRouter(tags=["invites"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class InviteCreateResponse(BaseModel):
    id: int
    token: str
    session_id: int
    created_at: str
    expires_at: str


class InvitePublicView(BaseModel):
    """Payload returned by the public GET /invites/{token}.

    Deliberately minimal: the only fields needed to render a join
    screen. No member list, no creator user_id, no internal IDs.
    """

    session_id: int
    session_name: str
    inviter_display_name: str
    status: str  # "active" | "accepted" | "expired" | "deleted"
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


def _classify_invite(invite: SessionInvite) -> str:
    """Return the public status string for an invite row.

    Order matters: deleted_at (owner-revoked) wins over "accepted"
    because once revoked the invite is no longer joinable regardless
    of prior acceptance.
    """
    if invite.deleted_at is not None:
        return "deleted"
    if invite.used_at is not None:
        return "accepted"
    now = datetime.now(timezone.utc)
    expires = invite.expires_at
    if expires is not None:
        # Same convention as _iso: a naive value came from SQLite's
        # naive storage of a tz-aware UTC datetime, so it represents UTC.
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= now:
            return "expired"
    return "active"


# ---------------------------------------------------------------------------
# POST /sessions/{session_id}/invites
# ---------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/invites",
    response_model=InviteCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_invite(
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Mint a new invite link for the session.

    Any member of the session can generate one (the link is just a
    token; once it leaves the chat it works the same regardless of
    who shared it).

    201: invite row created with 32-byte URL-safe token + TTL.
    401: not logged in.
    403: not a member of the session.
    """
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=settings.invite_ttl_days)

    # Loop on the (extremely unlikely) unique-token collision. 32 bytes
    # of randomness = 256 bits, but cheap to retry once just in case.
    invite: SessionInvite | None = None
    for _ in range(3):
        token = secrets.token_urlsafe(32)
        candidate = SessionInvite(
            session_id=sm.session_id,
            token=token,
            created_by=sm.user_id,
            expires_at=expires_at,
        )
        db.add(candidate)
        try:
            db.commit()
            invite = candidate
            break
        except IntegrityError:
            db.rollback()
            continue
    if invite is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "could not mint unique invite token"},
        )
    db.refresh(invite)

    return {
        "id": invite.id,
        "token": invite.token,
        "session_id": invite.session_id,
        "created_at": _iso(invite.created_at),
        "expires_at": _iso(invite.expires_at),
    }


# ---------------------------------------------------------------------------
# DELETE /sessions/{session_id}/invites/{invite_id}
# ---------------------------------------------------------------------------


@router.delete(
    "/sessions/{session_id}/invites/{invite_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_invite(
    sm: Annotated[SessionMember, Depends(require_session_owner)],
    db: Annotated[Session, Depends(get_db)],
    invite_id: int = Path(..., description="SessionInvite.id"),
) -> None:
    """Owner-only soft-delete of an invite.

    204: deleted.
    401: not logged in.
    403: not the session owner.
    404: invite does not exist OR was already accepted (we do not let
         owners revoke consumed invites — the accept flow is the
         single point where membership is created).
    """
    invite = (
        db.query(SessionInvite)
        .filter_by(id=invite_id, session_id=sm.session_id)
        .first()
    )
    if invite is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "invite not found"},
        )
    if invite.used_at is not None:
        # Already accepted → cannot be revoked.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "invite not found"},
        )

    invite.deleted_at = datetime.now(timezone.utc)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# GET /invites/{token}  (public)
# ---------------------------------------------------------------------------


@router.get(
    "/invites/{token}",
    response_model=InvitePublicView,
)
async def get_invite_public(
    db: Annotated[Session, Depends(get_db)],
    token: str = Path(..., description="Invite token from link"),
) -> dict:
    """Public preview of an invite — no auth required.

    200: payload returned for an active invite.
    400: invalid token format.
    404: invite does not exist (we deliberately do NOT distinguish
         "not in DB" from "deleted" here — both look the same to
         a non-member probing the link).
    410: invite is in a non-active state (already accepted, or expired).
         Body still carries the status field so the UI can render the
         right "this link was already used / has expired" message.
    """
    if not token or len(token) < 16 or len(token) > 128:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid token format"},
        )

    invite = db.query(SessionInvite).filter_by(token=token).first()
    if invite is None or invite.deleted_at is not None:
        # Same shape as "not found" — no enumeration leak.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "invite not found"},
        )

    session = db.query(SessionModel).filter_by(id=invite.session_id).first()
    if session is None:
        # Orphan invite (parent session deleted). Treat as not found.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "invite not found"},
        )

    # The inviter is the user whose display name shows in the preview
    # — we want their *session-scoped* nickname if we can find it,
    # falling back to their global default_name.
    inviter_member = (
        db.query(SessionMember)
        .filter_by(session_id=invite.session_id, user_id=invite.created_by)
        .first()
    )
    if inviter_member is not None:
        inviter_display_name = inviter_member.display_name
    else:
        inviter = db.query(User).filter_by(id=invite.created_by).first()
        inviter_display_name = inviter.default_name if inviter is not None else ""

    body = {
        "session_id": session.id,
        "session_name": session.name,
        "inviter_display_name": inviter_display_name,
        "status": _classify_invite(invite),
        "expires_at": _iso(invite.expires_at),
    }

    # Non-active invites (already accepted, or expired) return 410 Gone
    # so the UI can show a "link no longer available" message. The body
    # still carries `status` + session metadata for the screen.
    if body["status"] != "active":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=body,
        )

    return body


# ---------------------------------------------------------------------------
# POST /invites/{token}/accept  (requires auth)
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

    200: caller added to the session as role='member'. Body carries
         the resulting state so the UI can navigate straight into
         the new session.
    400: invalid token format / blank display_name.
    401: caller is not logged in.
    410: invite does not exist, was deleted by the owner, has
         already been accepted, or has expired.
    500: DB failure.
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

    invite = db.query(SessionInvite).filter_by(token=token).first()
    if invite is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"error": "invite no longer available"},
        )

    # Idempotency: if the caller is already a member of this session,
    # we short-circuit and return the existing membership rather than
    # failing. Common case: user clicks the link from two devices.
    # This check runs BEFORE _classify_invite so a returning member
    # always gets 200 even if the invite has already been accepted.
    existing = (
        db.query(SessionMember)
        .filter_by(session_id=invite.session_id, user_id=user.id)
        .first()
    )
    if existing is not None:
        return {
            "session_id": existing.session_id,
            "role": existing.role,
            "display_name": existing.display_name,
            "joined_at": _iso(existing.joined_at),
        }

    public_status = _classify_invite(invite)
    if public_status != "active":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"error": f"invite {public_status}"},
        )

    try:
        sm = SessionMember(
            session_id=invite.session_id,
            user_id=user.id,
            display_name=display_name,
            role=SessionRole.MEMBER.value,
        )
        db.add(sm)
        invite.used_at = datetime.now(timezone.utc)
        invite.accepted_by_user_id = user.id
        db.commit()
        db.refresh(sm)
    except IntegrityError:
        db.rollback()
        # Race: two simultaneous accepts for the same (session,user).
        # The unique constraint protects us; surface as already-member.
        existing = (
            db.query(SessionMember)
            .filter_by(session_id=invite.session_id, user_id=user.id)
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
