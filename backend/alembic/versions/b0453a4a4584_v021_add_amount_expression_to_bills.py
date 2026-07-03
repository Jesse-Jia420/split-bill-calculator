"""v021_add_amount_expression_to_bills

Revision ID: b0453a4a4584
Revises: 181c0c376a4b
Create Date: 2026-07-03 15:20:22.949836

v0.2.1 T01 (PRD §3.6.1 / SPEC §3.6.1) — add ``amount_expression`` to bills.

Stores the raw calculator expression (e.g. ``"350/5"``) alongside the
evaluated ``amount`` (NUMERIC(12,2)-equivalent float). The frontend
echoes the expression back so editing yields the same value the user
originally typed.

Design notes
------------
- ``amount_expression`` is **NULLable**: pre-v0.2.1 bills never set
  it, and we intentionally do NOT backfill from amount (the original
  expression is unrecoverable). When the field is NULL the UI falls
  back to displaying ``amount`` only.
- VARCHAR(64) is generous: the longest legal expression is well under
  this (e.g. ``9999999.99+9999999.99+9999999.99`` ≈ 30 chars). 64 is
  friendly for "looks like a number" debugging if someone accidentally
  pastes something exotic.
- No data backfill needed: existing rows simply keep ``amount_expression IS NULL``.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b0453a4a4584'
down_revision: Union[str, Sequence[str], None] = '181c0c376a4b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the nullable amount_expression column to bills."""
    op.add_column(
        "bills",
        sa.Column("amount_expression", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    """Reverse: drop the amount_expression column. amount is preserved."""
    op.drop_column("bills", "amount_expression")
