"""Session isolation dependencies — Sprint 1 T07.

These FastAPI dependencies enforce session-level access control. They
sit on top of the auth dependency (get_current_user) and provide:

* get_session_member — verifies the caller is a member of the
  session referenced by the URL path. Returns the SessionMember row
  so endpoints can read role / display_name without a second
  query.

* require_session_owner — extra check that the caller's role on the
  session is 'owner'. Used for owner-only actions (currently just
  revoking invites).

Design notes
------------
- We do NOT bake authorization into the ORM (no row-level filter
  hooks); every endpoint must explicitly declare the dependency it
  needs. This is loud: a wrong dependency is a 401/403 in tests, not
  a silent data leak in prod.
- The SessionMember is returned (not just a boolean) so callers can
  read session_member.role / .display_name / .joined_at
  without a follow-up query.
- We never leak whether the session exists vs. whether the caller is
  not a member: both return 403 with the same message. (For 404 we
  raise inside the route — see sessions API.)
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Path, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.users import User


def get_session_member(
    session_id: int = Path(..., description="Session ID from URL"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SessionMember:
    """Resolve and authorize the caller's membership in the session.

    403 if the caller is not a member of the session. Returns the
    SessionMember ORM row so handlers can use .role and
    .display_name directly.
    """
    sm: SessionMember | None = (
        db.query(SessionMember)
        .filter_by(session_id=session_id, user_id=user.id)
        .first()
    )
    if sm is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "not a session member"},
        )
    return sm


def require_session_owner(
    sm: SessionMember = Depends(get_session_member),
) -> SessionMember:
    """Restrict a session action to the owner.

    Stacks on get_session_member — a non-member would already 403
    in the underlying dep, so by the time we run, the caller IS a
    member. We only need to check the role.

    Returns the SessionMember for downstream handlers that need the
    caller's role/display_name.
    """
    if sm.role != SessionRole.OWNER.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "owner role required"},
        )
    return sm
