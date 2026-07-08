"""v0.3.x: add sessions.owner_email column for owner claim (PRD §3.11).

Revision ID: 20260708_add_sessions_owner_email
Revises: 20260706220410_bills_created_by_nullable
Create Date: 2026-07-08

v0.3.x (PRD §3.11): persistent owner email binding for anonymous-created
sessions. The wizard has NO email field (PO 04:17); instead, anonymous
creators see a "🔐 登录以保存" button that triggers POST /sessions/{id}/claim
after a successful email login, which sets BOTH owner_user_id and
owner_email atomically.

Notes:
- VARCHAR(255) matches the users.email column width (semantically the same
  value: a verified email address).
- No index: claim endpoint looks up by primary key (sessions.id); the
  column is only read alongside the row, never scanned (PRD §3.11.2).
- Nullable: anonymous creators leave both owner_user_id and owner_email
  NULL until they hit the claim endpoint.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260708_add_sessions_owner_email"
down_revision = "20260706220410_bills_created_by_nullable"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: only add if missing (older migrations may have run on
    # an already-mutated DB — see SPEC §D for the rationale).
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("sessions")} if insp.has_table("sessions") else set()
    if "owner_email" not in cols:
        with op.batch_alter_table("sessions") as batch_op:
            batch_op.add_column(
                sa.Column("owner_email", sa.String(length=255), nullable=True)
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("sessions")} if insp.has_table("sessions") else set()
    if "owner_email" in cols:
        with op.batch_alter_table("sessions") as batch_op:
            batch_op.drop_column("owner_email")
