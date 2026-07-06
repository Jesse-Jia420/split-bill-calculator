"""Session membership — links a user to a session with a per-session display name."""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

from app.db.models.sessions import Session
from app.db.models.users import User


class SessionRole(str, enum.Enum):
    OWNER = "owner"
    MEMBER = "member"


class SessionMember(Base):
    __tablename__ = "session_members"
    __table_args__ = (
        UniqueConstraint("session_id", "user_id", name="uq_session_members_session_user"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # v0.3 (PRD §3.10): nullable for anonymous participants.
    # When user_id IS NULL, the row represents an anonymous nickname.
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default=SessionRole.MEMBER.value)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # ---- v0.3: anonymous participation (PRD §3.10) -----------------------
    # nickname_secret: 32-byte hex generated on claim; stored in localStorage.
    # NULL = not yet claimed. BE never returns the raw secret on reads.
    nickname_secret: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # is_anon: true when user_id IS NULL (anonymous participant).
    is_anon: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # claimed_at: when the nickname was claimed (NULL = unclaimed slot).
    claimed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # ----------------------------------------------------------------------

    session: Mapped["Session"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship(back_populates="memberships")
