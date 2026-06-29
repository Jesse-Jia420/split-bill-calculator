"""A session = one bill-tracking group (e.g. 'Bangkok 2026-06')."""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.bills import Bill
    from app.db.models.session_invites import SessionInvite
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

    owner: Mapped["User"] = relationship(
        back_populates="owned_sessions", foreign_keys=[owner_user_id]
    )
    members: Mapped[list["SessionMember"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    invites: Mapped[list["SessionInvite"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    bills: Mapped[list["Bill"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    settlements: Mapped[list["Settlement"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
