"""User model — a verified email becomes a global user."""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.sessions import Session

if TYPE_CHECKING:
    from app.db.models.auth_tokens import AuthToken
    from app.db.models.session_members import SessionMember


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    default_name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    auth_tokens: Mapped[list["AuthToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    memberships: Mapped[list["SessionMember"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    owned_sessions: Mapped[list["Session"]] = relationship(
        back_populates="owner",
        cascade="all, delete-orphan",
        foreign_keys="Session.owner_user_id",
    )
