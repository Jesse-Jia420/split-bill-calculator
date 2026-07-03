"""Sessions API — Sprint 1 T08 + v0.1.1 invite redesign.

Endpoints (mounted under /sessions; frontend calls them as
/api/sessions — the dev proxy strips the /api prefix):

POST   /sessions                      Create a session + add caller as owner
GET    /sessions                      List sessions the caller belongs to
GET    /sessions/{id}                 Session detail + member list
PATCH  /sessions/{id}/members/{mid}   Update caller's own display_name

Auth model
----------
- POST + GET require a logged-in user (cookie).
- GET /{id} requires the caller to be a session member (403 otherwise).
- PATCH /{id}/members/{mid} requires membership AND mid == caller.
  In v0.1 only the *self* row is editable; renaming teammates is
  out of scope and lands in v0.2 with the broader role matrix.

Response shape notes
--------------------
- Timestamps come back as ISO 8601 strings (pydantic serialisation).
- We DO NOT include emails of *other* members in the public detail;
  only the caller's email is included (use /auth/me if needed).
  This keeps the response payload tight and avoids accidental PII
  leakage via logs.

v0.1.1 changes (2026-06-30)
---------------------------
- create_session now also mints the per-session fixed invite token
  (30-day TTL, secrets.token_urlsafe(32)). The token + expiry are
  read back via GET /sessions/{id}/invite (see invites.py), not the
  summary response (keeps the list/detail payloads tight).
- The detail endpoint now exposes `invite_token_preview` only when
  the caller IS the owner (so the session page can show a copy/rotate
  shortcut inline). Non-owners still 200 but get no preview.

Datetime handling
-----------------
SQLite strips tzinfo on roundtrip for DateTime(timezone=True) columns,
so every value read back is naive. We always *write* tz-aware UTC
datetimes (Python-side) and rely on SQLAlchemy to normalise on save.
On read, naive values are interpreted as UTC (matching what we wrote).
The previous version re-tagged naive datetimes as local time, which
silently shifted UTC values by the local offset -- a latent bug that
v0.1.1's explicit invite_expires_at field surfaced in tests.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CreateSessionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class SessionSummary(BaseModel):
    """Single-session payload used in POST + GET /sessions responses."""

    id: int
    name: str
    owner_user_id: int
    role: str
    member_count: int | None = None  # only populated for list responses
    created_at: str


class SessionMemberOut(BaseModel):
    id: int
    user_id: int
    email: str
    display_name: str
    role: str
    joined_at: str


class SessionDetail(BaseModel):
    id: int
    name: str
    owner_user_id: int
    members: list[SessionMemberOut]
    created_at: str
    # v0.1.1: owner-only token preview. Frontend prefers the dedicated
    # GET /sessions/{id}/invite endpoint for live data; this is a hint
    # for inline display when the owner loads the page.
    invite_token_preview: str | None = None
    invite_expires_at: str | None = None
    # v0.2.1 T02 (PRD §3.6.2): SessionMember.ids of the most recent bill's
    # participants (NULL when the session has no bills yet). The frontend
    # uses this to prefill participants in BillForm's create mode.
    last_bill_participants: list[int] | None = None


class UpdateMemberRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=50)


class UpdateMemberResponse(BaseModel):
    user_id: int
    display_name: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: datetime | None) -> str:
    """Serialise a (possibly naive) datetime as an ISO 8601 string.

    Always treats naive datetimes as UTC. SQLite stores our tz-aware
    UTC writes as naive UTC values; treating them as local on read
    would silently shift every timestamp by the local offset.
    """
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _summary_dict(session: SessionModel, role: str, member_count: int | None) -> dict:
    return {
        "id": session.id,
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "role": role,
        "member_count": member_count,
        "created_at": _iso(session.created_at),
    }


def _classify_invite_status(session: SessionModel) -> str:
    """Public invite status string for a session.

    Used by the invite endpoints (invites.py) and (mirrored) by the
    session detail endpoint. Returns "active" or "expired"; deleted /
    accepted no longer apply because there is one token per session
    that never goes into an "accepted" state (revisits are idempotent
    membership lookups, see SPEC §3.4.2 + PO decision B ii).
    """
    expires = session.invite_expires_at
    if expires is None:
        return "active"
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        return "expired"
    return "active"


# ---------------------------------------------------------------------------
# POST /sessions
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=SessionSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    payload: CreateSessionRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a new session and make the caller the owner member.

    v0.1.1: also mints the per-session fixed invite token (30-day TTL
    by default). The token is returned indirectly via
    GET /sessions/{id}/invite -- the summary response intentionally
    omits it so list payloads stay compact.

    201: session created.
    401: no/invalid cookie.
    422: missing/empty/over-long name (pydantic).
    """
    name = payload.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "name must not be blank"},
        )

    now = datetime.now(timezone.utc)
    invite_token = secrets.token_urlsafe(32)

    session = SessionModel(
        name=name,
        owner_user_id=user.id,
        invite_token=invite_token,
        invite_expires_at=now + timedelta(days=settings.invite_ttl_days),
        invite_created_at=now,
    )
    db.add(session)
    db.flush()  # populate session.id

    # Owner is also a SessionMember (role='owner'). Their per-session
    # nickname defaults to their global default_name; they can PATCH
    # it later via PATCH /sessions/{id}/members/{mid}.
    sm = SessionMember(
        session_id=session.id,
        user_id=user.id,
        display_name=user.default_name,
        role=SessionRole.OWNER.value,
    )
    db.add(sm)
    db.commit()
    db.refresh(session)

    return _summary_dict(session, role=SessionRole.OWNER.value, member_count=1)


# ---------------------------------------------------------------------------
# GET /sessions
# ---------------------------------------------------------------------------


@router.get("", response_model=list[SessionSummary])
async def list_sessions(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict]:
    """List every session the caller belongs to.

    200: list of session summaries, ordered by created_at DESC (newest
    first) so the most recent trip is at the top of the UI.
    401: no/invalid cookie.
    """
    rows = (
        db.query(SessionModel, SessionMember)
        .join(SessionMember, SessionMember.session_id == SessionModel.id)
        .filter(SessionMember.user_id == user.id)
        .order_by(SessionModel.created_at.desc())
        .all()
    )

    out: list[dict] = []
    for session, sm in rows:
        # Count members in a second query — cheap for v0.1 (sessions are
        # small), avoids GROUP-BY plumbing for now.
        count = (
            db.query(func.count(SessionMember.id))
            .filter(SessionMember.session_id == session.id)
            .scalar()
        )
        out.append(_summary_dict(session, role=sm.role, member_count=int(count or 0)))
    return out


# ---------------------------------------------------------------------------
# GET /sessions/{id}
# ---------------------------------------------------------------------------


def _compute_last_bill_participants(
    db: Session, session_id: int
) -> list[int] | None:
    """Find the most recent bill in the session and return its participant IDs.

    Returns ``None`` if the session has no bills yet (frontend treats
    that as "no history → fall back to default-all-included"). The "most
    recent" bill is the one with the latest occurred_at; ties broken by
    higher id (most recently created).
    """
    from app.db.models.bills import Bill
    from app.db.models.bill_participants import BillParticipant

    bill = (
        db.query(Bill)
        .filter(Bill.session_id == session_id)
        .order_by(Bill.occurred_at.desc(), Bill.id.desc())
        .first()
    )
    if bill is None:
        return None
    rows = (
        db.query(BillParticipant.member_id)
        .filter(BillParticipant.bill_id == bill.id)
        .order_by(BillParticipant.member_id.asc())
        .all()
    )
    return [mid for (mid,) in rows]


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session(
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Session detail + member list.

    200: detail payload.
    401: no/invalid cookie.
    403: caller is not a member of the session.
    404: session does not exist (only reached if the membership row
         points to a now-deleted session — see session_isolation for the
         403 path).

    v0.1.1: when the caller is the owner, the response also carries
    `invite_token_preview` + `invite_expires_at` so the frontend can
    pre-populate the inline invite link without an extra round-trip.
    Non-owners get the response without those fields.
    """
    session = db.query(SessionModel).filter_by(id=sm.session_id).first()
    if session is None:
        # Should be impossible — FK ON DELETE CASCADE — but stay defensive.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    members = (
        db.query(SessionMember, User)
        .join(User, User.id == SessionMember.user_id)
        .filter(SessionMember.session_id == session.id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )

    last_bill_participants = _compute_last_bill_participants(db, session.id)

    payload: dict = {
        "id": session.id,
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "members": [
            {
                "id": sm_row.id,
                "user_id": u.id,
                "email": u.email,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "joined_at": _iso(sm_row.joined_at),
            }
            for sm_row, u in members
        ],
        "created_at": _iso(session.created_at),
        "invite_token_preview": None,
        "invite_expires_at": None,
        "last_bill_participants": last_bill_participants,
    }

    # Owner-only invite preview. Non-owners still get 200 but with NULL
    # fields; the frontend then loads GET /sessions/{id}/invite on demand.
    if sm.role == SessionRole.OWNER.value:
        payload["invite_token_preview"] = session.invite_token
        payload["invite_expires_at"] = _iso(session.invite_expires_at)

    return payload


# ---------------------------------------------------------------------------
# PATCH /sessions/{id}/members/{mid}
# ---------------------------------------------------------------------------


@router.patch(
    "/{session_id}/members/{member_id}",
    response_model=UpdateMemberResponse,
)
async def update_member_display_name(
    payload: UpdateMemberRequest,
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
    member_id: int = Path(..., description="SessionMember.id"),
) -> dict:
    """Update the caller's own per-session nickname.

    v0.1 simplification: member_id MUST equal the caller's row in
    that session. Anything else is a 403. This avoids the v0.2
    permission matrix (owner renames / admin renames) and keeps the
    endpoint scope tight.

    200: nickname updated.
    400: empty / over-50 chars (pydantic).
    401: no/invalid cookie.
    403: caller is not a member, OR member_id is not theirs.
    404: member row doesn't exist in this session.
    """
    if member_id != sm.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "can only update your own member row"},
        )

    new_name = payload.display_name.strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "display_name must not be blank"},
        )

    sm.display_name = new_name
    db.commit()
    db.refresh(sm)
    return {"user_id": sm.user_id, "display_name": sm.display_name}
