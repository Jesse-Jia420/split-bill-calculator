"""A single bill (expense) within a session.

v0.2.2 (2026-07-03): ``amount`` upgraded from Float to Numeric(12, 2)
and a new ``exchange_rate_snapshot`` column records the rate that was
active when the bill was recorded (PRD §3.7.5 — snapshot mode: rate
changes never retroactively affect historical bills).

Float → Numeric 精度无损
-------------------------
旧 Float (IEEE-754 double) 有 15-17 位有效数字,远高于 Numeric(12, 2)
要求的 2 位小数。alembic migration ``f3a2e3b592b8`` 通过
``postgresql_using='amount::numeric(12,2)'`` 强转 (SQLite 的
batch_alter_table 自动处理); 27 笔 Thailand 测试数据迁移前后
``SUM(amount)`` 相等 (test ``test_existing_27_bills_thailand_total_
unchanged_after_migration`` 验证)。
"""
from __future__ import annotations

import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, func
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
    # v0.2.2: Float → Numeric(12, 2) (PRD §3.7.6). The Python side sees
    # ``Decimal`` so settlement maths stays in Decimal throughout — no
    # silent IEEE-754 drift.
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="CNY", server_default="CNY")
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # v0.2.1 T01 (PRD §3.6.1): raw calculator expression echoed verbatim
    # alongside the evaluated Decimal ``amount``. NULL for bills created
    # before v0.2.1 (no backfill -- original expression is unrecoverable).
    amount_expression: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # v0.2.2: rate snapshot (PRD §3.7.5). Stored when ``currency`` differs
    # from the session's ``primary_currency`` at record time; NULL when
    # the bill is already in the primary currency (no conversion needed).
    # Numeric(28, 8) gives 28 integer digits + 8 fractional — overkill for
    # any conceivable FX rate, but matches the SessionExchangeRate
    # precision so settlement can do ``amount * snapshot`` directly.
    exchange_rate_snapshot: Mapped[Decimal | None] = mapped_column(
        Numeric(28, 8), nullable=True
    )
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # v0.3.1: nullable for anonymous bill creation (members with user_id=NULL).
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
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
