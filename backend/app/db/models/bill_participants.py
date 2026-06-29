"""Who participates in a bill and any exclusive (solo-paid) amounts."""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Float, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.bills import Bill
    from app.db.models.session_members import SessionMember


class BillParticipant(Base):
    __tablename__ = "bill_participants"
    __table_args__ = (
        UniqueConstraint("bill_id", "member_id", name="uq_bill_participants_bill_member"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bill_id: Mapped[int] = mapped_column(
        ForeignKey("bills.id", ondelete="CASCADE"), nullable=False, index=True
    )
    member_id: Mapped[int] = mapped_column(
        ForeignKey("session_members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    is_exclusive: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )
    exclusive_amount: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0"
    )

    bill: Mapped["Bill"] = relationship(back_populates="participants")
    member: Mapped["SessionMember"] = relationship(foreign_keys=[member_id])
