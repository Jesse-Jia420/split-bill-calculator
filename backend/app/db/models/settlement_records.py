"""v0.3.32 — UAT 0725-2 #1: 已结算记录 table (per-currency, per-pair).

Records a manual "I already gave you X (in currency Y)" entry. The settle
algorithm subtracts these from the suggested transfers so the user sees
"remaining to transfer" rather than the raw bills math.

Naming note
-----------
The legacy ``settlements`` table (snapshot of the settle summary, written
on every /sessions/{id}/settle GET) is unrelated — that table captures
``summary_json`` snapshots for audit/history and lives in
``app/db/models/settlements.py``. We deliberately use the new table name
``settlement_records`` to avoid shadowing that model. The user-facing
section in the FE still reads as "已结算记录" (the meaning matches), but
the DB column name is more specific.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

from app.db.models.sessions import Session


class SettlementRecord(Base):
    __tablename__ = "settlement_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Payer (the member who already gave money) — SessionMember.id, NOT User.id.
    payer_id: Mapped[int] = mapped_column(
        ForeignKey("session_members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Payee (the member who already received money).
    payee_id: Mapped[int] = mapped_column(
        ForeignKey("session_members.id", ondelete="CASCADE"), nullable=False, index=False
    )
    # ISO 4217 currency code; must be in the session's ``currencies`` set at write
    # time. We deliberately don't FK to a currencies table — sessions.py keeps
    # currencies as a JSON array for now.
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    # Numeric(12, 2) matches the Bill table convention (T07 migration). The CHECK
    # ``amount > 0`` is duplicated in the pydantic CreateSettlementRequest and in
    # the API handler so a malformed direct write still fails at the DB layer.
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The SessionMember.id who created this record. Nullable because we ON DELETE
    # SET NULL (creator may leave the session without losing the record).
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("session_members.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    session: Mapped["Session"] = relationship(back_populates="settlement_records")