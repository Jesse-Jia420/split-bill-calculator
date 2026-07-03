"""A single bill (expense) within a session."""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

from app.db.models.sessions import Session


class BillStatus(str, enum.Enum):
    DRAFT = "draft"
    LOCKED = "locked"


class Bill(Base):
    __tablename__ = "bills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    payer_id: Mapped[int] = mapped_column(
        ForeignKey("session_members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="CNY", server_default="CNY")
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # v0.2.1 T01 (PRD §3.6.1): raw calculator expression echoed verbatim
    # alongside the evaluated Decimal ``amount``. NULL for bills created
    # before v0.2.1 (no backfill -- original expression is unrecoverable).
    amount_expression: Mapped[str | None] = mapped_column(String(64), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_by: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=BillStatus.DRAFT.value, server_default="draft")

    session: Mapped["Session"] = relationship(back_populates="bills")
    payer: Mapped["SessionMember"] = relationship(foreign_keys=[payer_id])
    creator: Mapped["User"] = relationship(foreign_keys=[created_by])
    participants: Mapped[list["BillParticipant"]] = relationship(
        back_populates="bill", cascade="all, delete-orphan"
    )
    comments: Mapped[list["BillComment"]] = relationship(
        back_populates="bill", cascade="all, delete-orphan"
    )
