"""v0.3.32 -- UAT 0725-2 #1: settlement_records table.

Revision ID: 20260725_v0325_0725_2_1_settlement_records
Revises: 20260718_v0317_bills_creator_sm_id
Create Date: 2026-07-25

Background
----------
PO 2026-07-25 20:24 UAT 0725-2 #1 added the '已结算记录' feature to the
settle overview page: a user can record 'I already paid X to Y (in
currency Z)' and the suggested transfer list subtracts that X so the
remaining balance is visible.

Design
------
New table settlement_records (per-pair, per-currency):

  id              INTEGER PK
  session_id      INTEGER FK sessions(id) ON DELETE CASCADE (indexed)
  payer_id        INTEGER FK session_members(id) ON DELETE CASCADE (indexed)
  payee_id        INTEGER FK session_members(id) ON DELETE CASCADE (indexed)
  currency        VARCHAR(3) -- must be in the session's currencies set
  amount          NUMERIC(12,2) -- CHECK > 0 (matches Bill precision)
  note            TEXT NULL
  created_by      INTEGER FK session_members(id) ON DELETE SET NULL (nullable)
  created_at      DATETIME UTC default now()

Naming note: the legacy settlements table (snapshot of the settle
summary) is unrelated -- it captures summary_json snapshots for
audit/history. We deliberately use the more specific name
settlement_records to avoid shadowing that model.

Implementation note -- SQLite FKs in CREATE TABLE
------------------------------------------------
SQLite supports FOREIGN KEY clauses inline in CREATE TABLE statements,
unlike SQLite ALTER TABLE which requires batch_alter_table for FKs.
We use inline FKs (declarative on sa.Column) so the migration is a
single op.create_table + three op.create_index calls -- no batch mode
required, matching the pattern in fc3262e0bb12_init_9_tables_bill_comments.py.
The CHECK > 0 on amount is also inline in CREATE TABLE (no separate
constraint add), so SQLite ALTER limitations do not apply.

Idempotency
-----------
Migration inspects table existence before CREATE so re-running is safe
(the v0.1.x migrations all rely on the same pattern).
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260725_v0325_0725_2_1_settlement_records"
down_revision = "20260718_v0317_bills_creator_sm_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    has_table = insp.has_table("settlement_records")

    if not has_table:
        # SQLite supports FOREIGN KEY + CHECK inline in CREATE TABLE.
        # No batch_alter_table required because this is a fresh table.
        op.create_table(
            "settlement_records",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "session_id",
                sa.Integer(),
                sa.ForeignKey("sessions.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "payer_id",
                sa.Integer(),
                sa.ForeignKey("session_members.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "payee_id",
                sa.Integer(),
                sa.ForeignKey("session_members.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("currency", sa.String(length=3), nullable=False),
            sa.Column("amount", sa.Numeric(12, 2), nullable=False),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column(
                "created_by",
                sa.Integer(),
                sa.ForeignKey("session_members.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.CheckConstraint("amount > 0", name="ck_settlement_records_amount_pos"),
        )
        # Indexes -- required for the GET /sessions/{id}/settlement_records
        # list query and for ON DELETE CASCADE lookups.
        op.create_index(
            "ix_settlement_records_session_id",
            "settlement_records",
            ["session_id"],
        )
        op.create_index(
            "ix_settlement_records_payer_id",
            "settlement_records",
            ["payer_id"],
        )
        op.create_index(
            "ix_settlement_records_payee_id",
            "settlement_records",
            ["payee_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("settlement_records"):
        op.drop_table("settlement_records")