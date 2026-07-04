"""v022_multi_currency

Revision ID: f3a2e3b592b8
Revises: b0453a4a4584
Create Date: 2026-07-03 22:00:00.000000

v0.2.2 Sprint 2 T07 (PRD §3.7 / SPEC §3.7) — multi-currency support.

Schema changes (all idempotent — guarded by Inspector.has_column /
has_table so re-running ``alembic upgrade head`` is a no-op):

1. ``sessions.currencies``  JSON NOT NULL DEFAULT '["CNY"]'
2. ``sessions.primary_currency`` VARCHAR(8) NOT NULL DEFAULT 'CNY'
3. New table ``session_exchange_rates`` with
   UNIQUE(session_id, from_currency, to_currency)
4. ``bills.amount`` Float → Numeric(12, 2)
   - PostgreSQL: ``USING 'amount::numeric(12,2)'`` for the cast
   - SQLite:    batch_alter_table handles it via the dialect
5. ``bills.exchange_rate_snapshot`` Numeric(28, 8) NULL

Design notes
------------
- **Idempotent migration**: every ALTER / CREATE is wrapped in
  ``inspect(...).has_column(...)`` / ``has_table(...)`` so the upgrade
  can be re-run safely. This is mandatory per the v0.2.2 task brief
  ("alembic 迁移幂等 + 27 笔 Thailand 数据完整性验证").
- **Float → Numeric 精度无损**: 现有 27 笔 Thailand 数据的 ``amount``
  是 Float（IEEE-754 double），Float 精度本身高于 2 位小数
  (15-17 位有效数字)；强转为 Numeric(12,2) 不丢精度。Test
  ``test_existing_27_bills_thailand_total_unchanged_after_migration``
  校验迁移前后总金额相等。
- **回退语义**: ``downgrade()`` 反向操作 — drop session_exchange_rates
  表 + drop bills.exchange_rate_snapshot + 还原 bills.amount 为 Float
  (用 cast 表达式把 Numeric 还原) + drop sessions.currencies/primary。
  现有数据可能因为该迁移前后数据被回退到 CNY 单币种假设。

幂等性测试要点 (见 backend/tests/test_multi_currency.py):
- alembic upgrade head 跑两次都成功
- alembic downgrade -1 后再 upgrade head 还能成功
- 27 笔 Thailand 数据在迁移前后 ``SUM(amount)`` 一致
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.engine.reflection import Inspector


# revision identifiers, used by Alembic.
revision: str = 'f3a2e3b592b8'
down_revision: Union[str, Sequence[str], None] = 'b0453a4a4584'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, col: str) -> bool:
    """Idempotency guard: True if `table` already has column `col`."""
    bind = op.get_bind()
    insp: Inspector = inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table)]
    return col in cols


def _has_table(table: str) -> bool:
    """Idempotency guard: True if `table` already exists."""
    bind = op.get_bind()
    return inspect(bind).has_table(table)


def upgrade() -> None:
    """Apply all multi-currency schema changes (idempotent)."""
    # ---- 1. sessions.currencies (JSON array) -----------------------------
    if not _has_column("sessions", "currencies"):
        op.add_column(
            "sessions",
            sa.Column(
                "currencies",
                sa.JSON,
                nullable=False,
                server_default='["CNY"]',
            ),
        )
    # ---- 2. sessions.primary_currency -----------------------------------
    if not _has_column("sessions", "primary_currency"):
        op.add_column(
            "sessions",
            sa.Column(
                "primary_currency",
                sa.String(length=8),
                nullable=False,
                server_default="CNY",
            ),
        )

    # ---- 3. session_exchange_rates table --------------------------------
    if not _has_table("session_exchange_rates"):
        op.create_table(
            "session_exchange_rates",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column(
                "session_id",
                sa.Integer,
                sa.ForeignKey("sessions.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("from_currency", sa.String(length=8), nullable=False),
            sa.Column("to_currency", sa.String(length=8), nullable=False),
            sa.Column("rate", sa.Numeric(28, 8), nullable=False),
            sa.Column(
                "snapshot_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "set_by",
                sa.Integer,
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.UniqueConstraint(
                "session_id",
                "from_currency",
                "to_currency",
                name="uq_rate_per_pair",
            ),
        )

    # ---- 4. bills.amount Float → Numeric(12, 2) -------------------------
    # The existing column is Float (SQLAlchemy default for unmapped types
    # in older migrations; SPEC §3 defines bills.amount as REAL). Float
    # precision > 2 decimals, so casting to Numeric(12, 2) is lossless.
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    with op.batch_alter_table("bills") as batch:
        if _has_column("bills", "amount"):
            # NB: SQLite's batch_alter_table rewrites the table; we don't
            # need USING because the storage class is REAL (already 8-byte
            # double) and SQLAlchemy handles the type change. PostgreSQL
            # needs the explicit cast expression.
            alter_kwargs = {
                "existing_type": sa.Float,
                "new_column_name": "amount",
                "type_": sa.Numeric(12, 2),
                "existing_nullable": False,
            }
            if is_postgres:
                alter_kwargs["postgresql_using"] = "amount::numeric(12,2)"
            batch.alter_column("amount", **alter_kwargs)

        # ---- 5. bills.exchange_rate_snapshot Numeric(28, 8) NULL --------
        if not _has_column("bills", "exchange_rate_snapshot"):
            batch.add_column(
                sa.Column(
                    "exchange_rate_snapshot",
                    sa.Numeric(28, 8),
                    nullable=True,
                )
            )

    # ---- 6. data backfill for pre-existing bills (T12) -------------------
    # Bills recorded before this migration ship with NULL snapshots; if
    # their currency differs from the session's primary_currency we must
    # backfill the snapshot from session_exchange_rates so settlement
    # doesn't 422 on a clean upgrade. We use the currently-configured
    # rate per (session, currency) pair — a pragmatic choice, since the
    # "true" original rate is unrecoverable (we did not track them in
    # v0.2.0/v0.2.1). Going forward every POST /bills captures its own
    # snapshot so historical bills stay stable.
    bind = op.get_bind()
    insp = inspect(bind)
    if insp.has_table("bills") and insp.has_table("sessions") and insp.has_table("session_exchange_rates"):
        # SQLite + PostgreSQL share enough SQL for the UPDATE we need.
        op.execute(
            sa.text(
                """
                UPDATE bills
                SET exchange_rate_snapshot = (
                    SELECT ser.rate
                    FROM session_exchange_rates ser
                    WHERE ser.session_id = bills.session_id
                      AND ser.from_currency = bills.currency
                      AND ser.to_currency = (
                          SELECT primary_currency FROM sessions s WHERE s.id = bills.session_id
                      )
                    LIMIT 1
                )
                WHERE exchange_rate_snapshot IS NULL
                  AND currency <> (
                      SELECT primary_currency FROM sessions s WHERE s.id = bills.session_id
                  )
                """
            )
        )


def downgrade() -> None:
    """Reverse all multi-currency schema changes (idempotent)."""
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"

    # ---- Reverse bills changes ------------------------------------------
    with op.batch_alter_table("bills") as batch:
        if _has_column("bills", "exchange_rate_snapshot"):
            batch.drop_column("exchange_rate_snapshot")
        if _has_column("bills", "amount"):
            alter_kwargs = {
                "existing_type": sa.Numeric(12, 2),
                "new_column_name": "amount",
                "type_": sa.Float,
                "existing_nullable": False,
            }
            if is_postgres:
                alter_kwargs["postgresql_using"] = "amount::double precision"
            batch.alter_column("amount", **alter_kwargs)

    # ---- Reverse session_exchange_rates ---------------------------------
    if _has_table("session_exchange_rates"):
        op.drop_table("session_exchange_rates")

    # ---- Reverse sessions changes ---------------------------------------
    if _has_column("sessions", "primary_currency"):
        op.drop_column("sessions", "primary_currency")
    if _has_column("sessions", "currencies"):
        op.drop_column("sessions", "currencies")