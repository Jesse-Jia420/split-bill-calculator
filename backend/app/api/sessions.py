"""Sessions API — Sprint 1 T08.

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
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
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


class UpdateMemberRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=50)


class UpdateMemberResponse(BaseModel):
    user_id: int
    display_name: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: datetime | None) -> str:
    """Serialise a (possibly naive) datetime as an ISO 8601 string."""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
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

    session = SessionModel(name=name, owner_user_id=user.id)
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

    return {
        "id": session.id,
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "members": [
            {
                "user_id": u.id,
                "email": u.email,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "joined_at": _iso(sm_row.joined_at),
            }
            for sm_row, u in members
        ],
        "created_at": _iso(session.created_at),
    }


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
