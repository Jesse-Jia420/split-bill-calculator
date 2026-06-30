"""A session = one bill-tracking group (e.g. 'Bangkok 2026-06').

v0.1.1 redesign (2026-06-30): each session now carries ONE fixed invite
token (with 30-day TTL, rotatable by the owner) instead of a separate
session_invites table with many per-link rows. See SPEC §3.4.2.
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.bills import Bill
    from app.db.models.session_members import SessionMember
    from app.db.models.settlements import Settlement
    from app.db.models.users import User


class Session(Base):  # noqa: F811 — intentional re-export as BillSession in models/__init__
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    owner_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )

    # ---- v0.1.1: per-session fixed invite token ----------------------------
    # One token per session, generated on session create. Rotatable by the
    # owner via POST /sessions/{id}/invite/rotate. 30-day TTL (configurable
    # via settings.invite_ttl_days). The token is 32-byte URL-safe (256 bits
    # of entropy); we store it in clear text because it's already a random
    # secret (hashing buys nothing extra -- see SPEC sec 3.4.2).
    invite_token: Mapped[str] = mapped_column(
        String(128), unique=True, nullable=False, index=True
    )
    invite_expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    invite_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # ------------------------------------------------------------------------

    owner: Mapped["User"] = relationship(
        back_populates="owned_sessions", foreign_keys=[owner_user_id]
    )
    members: Mapped[list["SessionMember"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    bills: Mapped[list["Bill"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    settlements: Mapped[list["Settlement"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
