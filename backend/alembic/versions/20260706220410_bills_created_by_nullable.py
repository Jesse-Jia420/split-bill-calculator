"""v0.3.1: make bills.created_by nullable for anonymous bill creation.

Revision ID: 20260706220410_bills_created_by_nullable
Revises: 20260707_session_code
Create Date: 2026-07-06

v0.3.1 (Bug & Issues) — bills.created_by FK to users.id was NOT NULL,
blocking anonymous members (user_id=NULL) from creating bills. This migration
makes the column nullable and changes the FK to ON DELETE SET NULL.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260706220410_bills_created_by_nullable"
down_revision = "20260707_session_code"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("bills") as batch_op:
        batch_op.alter_column(
            "created_by",
            existing_type=sa.Integer(),
            nullable=True,
        )


def downgrade() -> None:
    # v0.3.1: NOT NULL reversal — needs to drop NULL rows first.
    op.execute("DELETE FROM bills WHERE created_by IS NULL")
    with op.batch_alter_table("bills") as batch_op:
        batch_op.alter_column(
            "created_by",
            existing_type=sa.Integer(),
            nullable=False,
        )
