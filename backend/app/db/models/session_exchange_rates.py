"""Per-session manual exchange rates (v0.2.2 Sprint 2 T07/T09).

Each row records the conversion rate between two currencies for a single
session. Rates are set manually by the user (v0.2.2) — automatic API
integration (Frankfurter) is deferred to v0.2.3+ per PRD §3.7.5.

Key invariants
--------------
- ``UNIQUE(session_id, from_currency, to_currency)`` — only ONE rate
  per ordered pair per session. The reverse pair is a separate row.
  (PRD §3.7.5: when A→B is set we automatically also persist B→A as
  the reciprocal, so both directions are queryable.)
- The rate is stored as ``Numeric(28, 8)`` (28 integer digits + 8
  fractional) — adequate for any conceivable FX rate while leaving
  plenty of headroom for the integer part.
- ``snapshot_at`` is the wall-clock time of the last write. Bills
  recorded after this snapshot use this rate (snapshot mode, PRD
  §3.7.5 — old bills are NOT retroactively re-converted).
- ``set_by`` is the User.id that last wrote the rate (nullable for
  rows written before this field was populated; FK ON DELETE SET NULL
  so removing the user does not cascade-delete rate history).

Settlement read pattern (settle.py T11)
----------------------------------------
- When a bill's ``currency`` differs from the session's
  ``primary_currency`` we read the rate snapshot that was on the bill
  (each bill stores its own snapshot at record time).
- Rates here are only used to seed ``bill.exchange_rate_snapshot``
  at record time; we never re-read them for historical bills.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class SessionExchangeRate(Base):
    """One per (session, from_currency, to_currency) ordered pair."""

    __tablename__ = "session_exchange_rates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    from_currency: Mapped[str] = mapped_column(String(8), nullable=False)
    to_currency: Mapped[str] = mapped_column(String(8), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(28, 8), nullable=False)
    snapshot_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    set_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "from_currency",
            "to_currency",
            name="uq_rate_per_pair",
        ),
    )

    session: Mapped["Session"] = relationship(  # noqa: F821 — forward ref
        back_populates="exchange_rates"
    )